// The amounts of a Snowbridge top-up: the fees the message pays on each chain and the ether it
// must carry. Each fee is a live read of what a chain charges, with a margin on top. The margin
// depends on what a fee that is too low costs, and on where the unused part of the fee goes.

import type { SnowbridgeProgramInput } from "./program";

/** What the chains charge now for one message. Each figure is a live read. */
export interface SnowbridgeCosts {
  /** Asset Hub's price for the weight of the whole message, in wei. */
  assetHubExecution: bigint;
  /** The ether Asset Hub's pool takes for the delivery to Hydration, in wei. */
  hydrationDelivery: bigint;
  /** Hydration's price for the weight of the program it runs, in wei. */
  hydrationExecution: bigint;
  /** Asset Hub's price for the deposit of what Hydration sends back, in USDT base units. */
  depositUsdt: bigint;
  /** The same price in wei, for the ether that comes back when the swap fails. */
  depositEther: bigint;
  /** The least ether an account of Asset Hub can hold, in wei. */
  etherMinimum: bigint;
  /** The ether for Bridge Hub's delivery of the message to Asset Hub, in wei. */
  bridgeHubDelivery: bigint;
  /** The ether for the fee of the relayer's transaction on Bridge Hub, in wei. */
  relayerTransaction: bigint;
}

/** The execution fee is three times what Asset Hub charges. A fee that is too low stops the
 *  message on Asset Hub. Snowbridge's relayers run a message there in a dry run first, and they
 *  do not relay one that stops: they try again for 4 hours and then drop it. If such a message is
 *  relayed all the same, there are two cases. A fee that pays for the message and not for its
 *  delivery to Hydration leaves all the ether in a trap that the account can claim. A fee under
 *  the price of the message itself loses the ether: Asset Hub stops before it credits what the
 *  message carries. Asset Hub prices the fee through a pool that holds less than 1 ETH, so one
 *  trade by another account moves that price far. The unused part of the fee goes to the
 *  account as ether. */
const EXECUTION_MARGIN = 3n;

/** The Hydration fee is twice what Hydration charges. A fee that is too low loses the ether of
 *  the swap: Hydration stops before it credits that ether, and no account can claim it. The
 *  unused part stays in a trap on Hydration. */
const HYDRATION_MARGIN = 2n;

/** The fee of the deposit is 100 times what Asset Hub charges. A fee that is too low loses what
 *  came back, as on Hydration. The unused part goes to the account with the deposit, so the
 *  margin costs nothing. */
const DEPOSIT_MARGIN = 100n;

/** The margin Snowbridge's own tools put on the relayer's costs, in percent. A relayer takes a
 *  message when its fee is more than those costs. It takes an underpaid message too, after 4
 *  hours. */
const RELAYER_MARGIN_PERCENT = 30n;

export interface SnowbridgeSizing {
  /** The execution fee the Gateway takes: what the message pays on Asset Hub, in wei. */
  executionFee: bigint;
  /** The relayer fee the Gateway takes, in wei. */
  relayerFee: bigint;
  /** The ether the message carries on top of the two fees, in wei. */
  value: bigint;
  /** The ether to send with the call to the Gateway: the two fees and the value. */
  total: bigint;
  /** What the program is built from. */
  program: SnowbridgeProgramInput;
}

const COSTS = [
  "assetHubExecution",
  "hydrationDelivery",
  "hydrationExecution",
  "depositUsdt",
  "depositEther",
  "etherMinimum",
  "bridgeHubDelivery",
  "relayerTransaction",
] as const;

/** The amounts of a top-up that swaps `swapEther` wei for at least `minimumUsdt`. */
export function sizeSnowbridgeTopUp(args: {
  costs: SnowbridgeCosts;
  /** The request's account on Asset Hub, as 0x and 64 hex digits. */
  account: string;
  swapEther: bigint;
  minimumUsdt: bigint;
}): SnowbridgeSizing {
  const { costs, swapEther, minimumUsdt } = args;
  for (const name of COSTS) {
    if (costs[name] <= 0n) throw new Error(`${name} must be more than zero`);
  }
  const executionFee = EXECUTION_MARGIN * (costs.assetHubExecution + costs.hydrationDelivery);
  const hydrationFeeEther = HYDRATION_MARGIN * costs.hydrationExecution;
  const assetHubFeeUsdt = DEPOSIT_MARGIN * costs.depositUsdt;
  const assetHubFeeEther = DEPOSIT_MARGIN * costs.depositEther;
  const relayerCosts = costs.relayerTransaction + costs.bridgeHubDelivery;
  const relayerFee = (relayerCosts * (100n + RELAYER_MARGIN_PERCENT)) / 100n;
  // Each fee of the way back is taken from what comes back, so that must be more than the fee.
  if (swapEther <= assetHubFeeEther) {
    throw new Error("the ether to swap does not cover the fee of its own way back");
  }
  if (minimumUsdt <= assetHubFeeUsdt) {
    throw new Error("the least USDT of the swap does not cover the fee of its deposit");
  }
  // The minimum balance stays on Asset Hub, so that the deposit of the unused ether there never
  // fails for an account that holds no ether yet. A deposit that fails stops the message on
  // Asset Hub, and the relayers do not relay a message that stops there.
  const value = swapEther + hydrationFeeEther + costs.etherMinimum;
  return {
    executionFee,
    relayerFee,
    value,
    total: executionFee + relayerFee + value,
    program: {
      account: args.account,
      swapEther,
      hydrationFeeEther,
      minimumUsdt,
      assetHubFeeUsdt,
      assetHubFeeEther,
    },
  };
}
