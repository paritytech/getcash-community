// The checks of the two bridge routes at the quote of a top-up. Each says if its route can take
// the amount now, and what the top-up needs on it. Nothing is sent. The checks receive their
// reads as arguments, so this file holds no connection and no address of a node.
//
// The amounts are the ETH that the key of the request needs, with the gas of its transactions.
// getcash sends those transactions itself on purpose, so that a top-up needs no forwarder
// contract and no relayer.
// TODO: once a forwarder and a relayer exist, remove the gas, the data fee and the swap of ETH
// on Base from the amounts. The provider then delivers to the forwarder, and the relayer pays
// the gas.

import { vaultRefusal, type VaultState } from "./base/vault";
import type { BridgeAnswer } from "./route";
import { sizeSnowbridgeTopUp, type SnowbridgeSizing } from "./snowbridge/amounts";
import type { SnowbridgeTrial } from "./snowbridge/costs";
import { accountClaimer, snowbridgeProgram } from "./snowbridge/program";
import type { SnowbridgeMessage } from "./snowbridge/wrapper";

/** What the provider that delivers the ETH answers for an amount on the key. */
export type DeliveryAnswer =
  /** What the user is asked to pay, and the least of it the provider keeps, in the units of the
   *  asset they pay with. The provider returns the rest. */
  | { kind: "open"; pays: bigint; paysLeast: bigint }
  /** The amount is under the provider's minimum, which it states in wei or in US dollars. */
  | { kind: "too-small"; minimumWei?: bigint; minimumUsd?: number }
  | { kind: "closed"; reason: string }
  | { kind: "no-answer"; reason: string };

/** Asks the provider what the user pays for `wei` of ETH on the key. */
export type Delivery = (wei: bigint) => Promise<DeliveryAnswer>;

/** The fees of a chain of Ethereum's kind now, in wei for one unit of gas. */
export interface GasPrice {
  baseFee: bigint;
  tip: bigint;
}

const WEI = 10n ** 18n;
const BPS = 10_000n;

/** The gas the call to the Gateway gets at the quote. A message with ether only uses less than
 *  half of it. */
const GATEWAY_GAS = 150_000n;

/** The gas the swap, the approval and the deposit on Base get together at the quote. */
const BASE_GAS = 900_000n;

/** The USDC a Base top-up adds for the fee of the permit on Hydration and of the deposit on
 *  Asset Hub. */
const BASE_FEES_USDC = 200_000n;

/** The fees of the trial message: far above what the chains charge, so that every hop runs. */
const TRIAL_FEE_ETHER = 1_000_000_000_000_000n;
const TRIAL_FEE_USDT = 200_000n;

/** The most a transaction pays for `gas`: the base fee can double before it is in a block. */
const gasCost = (gas: bigint, price: GasPrice): bigint => gas * (2n * price.baseFee + price.tip);

const more = (amount: bigint, bps: bigint): bigint => (amount * (BPS + bps) + BPS - 1n) / BPS;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the user pays the provider for a top-up. */
export interface Payment {
  /** What the user is asked to pay, in the units of the asset they pay with. */
  pays: bigint;
  /** The least of it the provider keeps. The provider returns the rest. */
  paysLeast: bigint;
}

/** Asks the provider for `ethNeeded`, and turns its answer into the answer of the route. */
async function deliver<T>(
  delivery: Delivery,
  amountCash: bigint,
  ethNeeded: bigint,
  offer: (payment: Payment) => T,
): Promise<BridgeAnswer<T>> {
  let answer: DeliveryAnswer;
  try {
    answer = await delivery(ethNeeded);
  } catch (error) {
    return { kind: "no-answer", from: "provider", reason: reasonOf(error) };
  }
  if (answer.kind === "open") {
    return { kind: "open", value: offer({ pays: answer.pays, paysLeast: answer.paysLeast }) };
  }
  if (answer.kind === "no-answer") {
    return { kind: "no-answer", from: "provider", reason: answer.reason };
  }
  if (answer.kind === "closed") return answer;
  // 1 CASH is 1 US dollar, with 6 decimals. A minimum in wei is in proportion to what was asked.
  if (answer.minimumWei !== undefined) {
    const minimumCash = (amountCash * answer.minimumWei + ethNeeded - 1n) / ethNeeded;
    return { kind: "too-small", minimumCash };
  }
  if (answer.minimumUsd !== undefined) {
    return { kind: "too-small", minimumCash: BigInt(Math.ceil(answer.minimumUsd * 1_000_000)) };
  }
  return { kind: "closed", reason: "the amount is under the provider's minimum" };
}

export interface SnowbridgeAsk {
  /** The top-up, in CASH base units. The route must land this much USDT. */
  amountCash: bigint;
  /** The request's account on Asset Hub, as 0x and 64 hex digits. */
  account: string;
  /** The address of the key that sends the message. */
  sender: string;
  /** Why Snowbridge takes no message now, or null. */
  refusal(): Promise<string | null>;
  /** The fees of Ethereum. */
  gas(): Promise<GasPrice>;
  /** Runs a trial message through the three hops in dry runs. */
  trial(message: SnowbridgeMessage): Promise<SnowbridgeTrial>;
  /** The provider that delivers the ETH on Ethereum. Null when the user sends the ETH. */
  delivery: Delivery | null;
  /** The price of 1 ETH in USDT base units, from a source that is not Hydration. */
  usdtPerEther: bigint;
  /** The base fee of Ethereum above which the route is closed, in wei. */
  maxBaseFee: bigint;
  /** The most the swap on Hydration may lose against `usdtPerEther`, in basis points. */
  maxLossBps: bigint;
  /** The ether added to the swap so that it still pays enough after the price moves, in basis
   *  points. */
  toleranceBps: bigint;
}

export interface SnowbridgeOffer {
  route: "snowbridge";
  /** The wei the key needs on Ethereum: what the Gateway takes, and the gas. */
  ethNeeded: bigint;
  /** What the user pays the provider, or null when the user sends `ethNeeded`. */
  payment: Payment | null;
  /** The least USDT the swap pays. Under it, the ether comes back to Asset Hub. */
  minimumUsdt: bigint;
  /** The amounts of the message. */
  sizing: SnowbridgeSizing;
  /** What the swap on Hydration loses against the outside price of ether, in basis points. */
  lossBps: bigint;
}

/** Asks the Snowbridge route about a top-up. */
export async function askSnowbridge(ask: SnowbridgeAsk): Promise<BridgeAnswer<SnowbridgeOffer>> {
  let ethNeeded: bigint;
  let offer: Omit<SnowbridgeOffer, "payment">;
  try {
    const [refusal, gas] = await Promise.all([ask.refusal(), ask.gas()]);
    if (refusal !== null) return { kind: "closed", reason: refusal };
    if (gas.baseFee > ask.maxBaseFee) {
      return { kind: "closed", reason: `the base fee of Ethereum is ${gas.baseFee} wei` };
    }
    // The trial swaps the ether that is worth the amount plus the loss limit. When that pays
    // less than the amount, the swap loses more than the limit.
    const trialEther = (more(ask.amountCash, ask.maxLossBps) * WEI) / ask.usdtPerEther;
    const { costs, usdtOut } = await ask.trial({
      sender: ask.sender,
      nonce: 1n,
      value: trialEther + 2n * TRIAL_FEE_ETHER,
      executionFee: TRIAL_FEE_ETHER,
      claimer: accountClaimer(ask.account),
      program: snowbridgeProgram({
        account: ask.account,
        swapEther: trialEther,
        hydrationFeeEther: TRIAL_FEE_ETHER,
        minimumUsdt: 1n,
        assetHubFeeUsdt: TRIAL_FEE_USDT,
        assetHubFeeEther: TRIAL_FEE_ETHER,
      }),
    });
    // The deposit on Asset Hub takes its fee from the USDT.
    const minimumUsdt = ask.amountCash + 2n * costs.depositUsdt;
    if (usdtOut < minimumUsdt) {
      return {
        kind: "closed",
        reason: `the swap on Hydration pays ${usdtOut} USDT units for ether worth ${more(ask.amountCash, ask.maxLossBps)}`,
      };
    }
    // A smaller swap pays at least in proportion, so this ether pays the amount.
    const enough = (trialEther * minimumUsdt + usdtOut - 1n) / usdtOut;
    const worth = (enough * ask.usdtPerEther) / WEI;
    const sizing = sizeSnowbridgeTopUp({
      costs,
      account: ask.account,
      swapEther: more(enough, ask.toleranceBps),
      minimumUsdt,
    });
    ethNeeded = sizing.total + gasCost(GATEWAY_GAS, gas);
    offer = {
      route: "snowbridge",
      ethNeeded,
      minimumUsdt,
      sizing,
      lossBps: worth > minimumUsdt ? ((worth - minimumUsdt) * BPS) / worth : 0n,
    };
  } catch (error) {
    return { kind: "no-answer", from: "route", reason: reasonOf(error) };
  }
  if (ask.delivery === null) return { kind: "open", value: { ...offer, payment: null } };
  return deliver(ask.delivery, ask.amountCash, ethNeeded, (payment) => ({ ...offer, payment }));
}

export interface BaseAsk {
  /** The top-up, in CASH base units. The route must land this much USDT. */
  amountCash: bigint;
  /** What the vault on Base and the facilitator on Hydration say. */
  vault(): Promise<VaultState>;
  /** The wei of ETH the pool on Base takes for an amount of USDC. */
  ethFor(usdc: bigint): Promise<bigint>;
  /** The fees of Base. */
  gas(): Promise<GasPrice>;
  /** The most Base charges for the data of one transaction, in wei. */
  dataFee(): Promise<bigint>;
  /** The provider that delivers the ETH on Base. */
  delivery: Delivery;
  /** The USDC added for what the swap of HOLLAR to USDT loses, in basis points. */
  marginBps: bigint;
  /** The room the vault must have above the deposit, in basis points. Every user shares the
   *  room. */
  roomMarginBps: bigint;
  /** The ether added to the swap on Base so that it still pays enough after the price moves, in
   *  basis points. */
  toleranceBps: bigint;
}

export interface BaseOffer {
  route: "base";
  /** The wei the key needs on Base: the ETH to swap, the gas, the data fees and the fee of the
   *  vault's message. */
  ethNeeded: bigint;
  /** What the user pays the provider. */
  payment: Payment;
  /** The USDC to deposit in the vault. */
  usdc: bigint;
}

/** Asks the Base route about a top-up. */
export async function askBase(ask: BaseAsk): Promise<BridgeAnswer<BaseOffer>> {
  const usdc = more(ask.amountCash, ask.marginBps) + BASE_FEES_USDC;
  let ethNeeded: bigint;
  try {
    const state = await ask.vault();
    const refusal = vaultRefusal(state, more(usdc, ask.roomMarginBps));
    if (refusal !== null) return { kind: "closed", reason: refusal };
    const [swapEther, gas, dataFee] = await Promise.all([
      ask.ethFor(usdc),
      ask.gas(),
      ask.dataFee(),
    ]);
    ethNeeded =
      more(swapEther, ask.toleranceBps) + gasCost(BASE_GAS, gas) + 3n * dataFee + state.messageFee;
  } catch (error) {
    return { kind: "no-answer", from: "route", reason: reasonOf(error) };
  }
  return deliver(ask.delivery, ask.amountCash, ethNeeded, (payment) => ({
    route: "base",
    ethNeeded,
    payment,
    usdc,
  }));
}
