// Offline coverage over a scripted People and Asset Hub: the two transactions in order, the fee
// measurement converging on an exact allowance, the CASH leaving to the unit, the sale per tier,
// arrival by the destination's balance in the landing asset, the PSM tier's redeem from the key's
// Asset Hub account, and every refusal.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { TOKENS } from "@getsome/core";
import { MAX_PSM_REFUSALS, withFeeMargin, type ConversionRoute } from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  estimateDirectFeesCash,
  SWAP_HEADROOM_PCT,
  XCM_TX_FEE_HEADROOM_PCT,
} from "./fees";
import { PASEO_PEOPLE_POOL_ACCOUNT } from "./paseo";
import { cashInFor } from "./pool";
import { psmRedeemOut } from "./program";
import {
  freshWithdrawTickState,
  landingFloor,
  MAX_REJECTIONS,
  withdrawTickOnce,
  WithdrawHeldError,
  WithdrawRejectedError,
  type WithdrawStep,
  type WithdrawTickOutcome,
  type WithdrawTickState,
} from "./tick";

const ED = 1_000_000_000n; // 0.1 PAS
const RESERVES = { cash: 4_004_853_413n, pas: 9_987_917_550_000n };
/** What People charged the swap in CASH on Paseo: the pre-charge less the refund. */
const SWAP_FEE_CASH = 16_031n - 18n;
/** The swap's fee as People estimates it, in PAS, before the charge is priced in CASH. */
const SWAP_TX_FEE_PAS = 40_000_000n;
/** What People charges the XCM transaction in PAS, and the reserve the sizing keeps for it. */
const XCM_TX_FEE_PAS = 39_580_000n;
const RESERVE = (XCM_TX_FEE_PAS * BigInt(100 + XCM_TX_FEE_HEADROOM_PCT)) / 100n;
/** What People charges the XCM's execution: a small local part plus a delivery part that grows
 *  with the number of assets the forwarded message carries. */
const LOCAL = 410_000n;
const DELIVERY = { 1: 318_000_000n, 2: 319_700_000n } as const;
const WEIGHED = { ref_time: 2_358_560_232n, proof_size: 61_000n };
/** Asset Hub's sale price: planck per CASH unit. */
const AH_RATE = 3_780n;
/** The stable pools' price: planck per stable unit, one PAS to one USDC on a 10 to 6 decimal pair. */
const STABLE_PLANCK = 10_000n;
/** What the scripted Asset Hub charges the program in CASH. */
const AH_FEE_CASH = 3_546n;
const KEY_CASH = 20_999_683n;
const KEY = { address: "5Key", publicKeyHex: `0x${"07".repeat(32)}`, signer: {} as never };
const DESTINATION = new Uint8Array(32).fill(0xaa);
const DESTINATION_HEX = `0x${"aa".repeat(32)}`;
const DESTINATION_SS58 = AccountId(42).dec(DESTINATION);
/** What the destination holds before any withdrawal reaches it. */
const DESTINATION_PAS = 3n * ED;
const PSM_FEE_RATE = 5_000;
const PSM_SALE: ConversionRoute = { tier: "psm", external: "USDT", feeRate: PSM_FEE_RATE };
/** What Asset Hub charges a signed call of the key's in PAS, and what its pool asks for that
 *  in CASH. */
const AH_TX_FEE_PAS = 12_000_000n;
const AH_TX_FEE_CASH = AH_TX_FEE_PAS / AH_RATE;
const CASH_MIN_BALANCE = 1n;
const USDT_MIN_BALANCE = 70_000n;
const PSM_MIN_SWAP = 1_000_000n;

type Instruction = { type: string; value?: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type Exchange = { want: Fungible[] };
type AssetLocation = { parents: number; interior: { value: Array<{ value: unknown }> } };
type Message = { type: string; value: Instruction[] };
type ExecuteArgs = { message: Message; max_weight: unknown };
type SwapArgs = { amount_out: bigint; amount_in_max: bigint };
type Submit = { call: string; args: unknown; options: Record<string, unknown> };
type Call = { type: string; value: { type: string; value: unknown } };
type RedeemArgs = { internal_amount: bigint; max_fee: number };
type TransferAllArgs = { dest: { value: string } };
type ExitSwapArgs = { amount_in: bigint; amount_out_min: bigint; send_to: string };

const incomplete = (index: number, error: string) => ({
  type: "Module",
  value: {
    type: "PolkadotXcm",
    value: { type: "LocalExecutionIncompleteWithError", value: { index, error: { type: error } } },
  },
});
const moduleError = (pallet: string, variant: string) => ({
  type: "Module",
  value: { type: pallet, value: { type: variant } },
});
const trappedEvent = (amount: bigint) => ({
  type: "PolkadotXcm",
  value: {
    type: "AssetsTrapped",
    value: { assets: { type: "V5", value: [{ fun: { type: "Fungible", value: amount } }] } },
  },
});
const rejectedExecution = (error: unknown) => ({
  success: true,
  value: {
    execution_result: { success: false, value: { error } },
    emitted_events: [],
    forwarded_xcms: [],
  },
});
/** A hop that gives the native, which only the dotUSD tier's dust sale does first. */
const givesNative = (hop: Instruction | undefined) =>
  (hop?.value as { give: { value: { value: { id: { parents: number } } } } } | undefined)?.give
    .value.value.id.parents === 1;
/** Asset Hub crediting `who`: the native's Deposit, or a token's Deposited. */
const deposited = (assetId: number | null, amount: bigint, who: string) => ({
  type: assetId === null ? "Balances" : "Assets",
  value: {
    type: assetId === null ? "Deposit" : "Deposited",
    value: {
      ...(assetId === null ? {} : { asset_id: assetId }),
      who,
      amount,
    },
  },
});
/** The account a program's last instruction deposits to, public key hex. */
const beneficiaryOf = (program: Instruction[]): string =>
  (
    program[program.length - 1]!.value as {
      beneficiary: { interior: { value: { value: { id: string } } } };
    }
  ).beneficiary.interior.value.value.id;
const ss58Of = (hex: string) => AccountId(42).dec(hex);

/** Scripted People and Asset Hub. The pool, the fees and the dry runs answer as the live chains
 *  did in the probes; the switches script the failures. */
function scriptedWorld(
  opts: {
    /** The destination shows the PAS after this many reads following the XCM. */
    arrivalAfterReads?: number;
    /** Asset Hub credits this much less than its dry run said. */
    landShort?: bigint;
    /** People rejects the XCM at inclusion with this XCM error. */
    rejectXcm?: string;
    /** The XCM lands but the submit's answer never comes back. */
    loseXcmAnswer?: boolean;
    /** Asset Hub's dry run traps this much. */
    trapOnAssetHubDryRun?: bigint;
    /** The PSM refuses the redeem with this error of its own, at the dry run and at inclusion. */
    refuseRedeem?: string;
  } = {},
) {
  const state = {
    keyCash: KEY_CASH,
    keyPas: 0n,
    dustLost: 0n,
    submits: [] as Submit[],
    dryRuns: 0,
    /** Dry runs of the key's signed calls on Asset Hub. */
    exitDryRuns: 0,
    /** The PSM's room for a redeem, the pair's debt; the PSM tier's tests set it. */
    psmDebt: 0n,
    /** The key's own Asset Hub account: the CASH the PSM tier's XCM lands and the stable its
     *  redeem leaves there. */
    keyCashAh: 0n,
    keyUsdtAh: 0n,
    destinationPas: DESTINATION_PAS,
    /** What the last Asset Hub dry run credited to the program's beneficiary. */
    lastDryRunLanded: 0n,
    /** The account the XCM that went out lands on, public key hex. */
    xcmTo: null as string | null,
    xcmLanded: false,
    pasLanded: false,
    destinationReads: 0,
  };

  const payFeesOf = (message: Message) =>
    (message.value[1]!.value as { asset: Fungible }).asset.fun.value;
  const withdrawnOf = (message: Message) => message.value[0]!.value as Fungible[];
  const assetsCount = (message: Message) => (message.value[2]!.value as Fungible[]).length;

  /** What People forwards for an XCM whose allowance leaves `pasLeft`. */
  function forwardedFor(message: Message): Message {
    const [pasWithdrawn, cashWithdrawn] = withdrawnOf(message);
    const pasLeft = pasWithdrawn!.fun.value - payFeesOf(message);
    const transfer = message.value[2]!.value as {
      remote_fees: { value: { value: Fungible[] } };
      remote_xcm: Instruction[];
    };
    const earmark = transfer.remote_fees.value.value[0]!;
    // The earmark comes out of the CASH withdrawn; the rest travels.
    const cashLeft = {
      ...cashWithdrawn!,
      fun: { type: "Fungible", value: cashWithdrawn!.fun.value - earmark.fun.value },
    };
    return {
      type: "V5",
      value: [
        { type: "ReceiveTeleportedAsset", value: [earmark] },
        { type: "PayFees", value: { asset: earmark } },
        {
          type: "ReceiveTeleportedAsset",
          value:
            pasLeft > 0n
              ? [{ ...pasWithdrawn!, fun: { type: "Fungible", value: pasLeft } }, cashLeft]
              : [cashLeft],
        },
        { type: "ClearOrigin" },
        ...transfer.remote_xcm,
        { type: "SetTopic", value: `0x${"00".repeat(32)}` },
      ],
    };
  }

  const txHashFor = () => `0x${state.submits.length.toString(16).padStart(64, "0")}`;

  /** The swap as People runs it: the fee comes off the CASH first, then the pool sells the exact
   *  PAS for what its reserves ask, within the cap. */
  const swapTx = (args: SwapArgs) => ({
    decodedCall: { type: "AssetConversion", value: { type: "swap", value: args } },
    getEstimatedFees: async () => SWAP_TX_FEE_PAS,
    signAndSubmit: async (_signer: unknown, options: Record<string, unknown>) => {
      state.submits.push({ call: "swap", args, options });
      state.keyCash -= SWAP_FEE_CASH;
      const cashIn = cashInFor(args.amount_out, RESERVES);
      if (cashIn > args.amount_in_max) {
        return {
          ok: false,
          txHash: txHashFor(),
          dispatchError: moduleError("AssetConversion", "ProvidedMaximumNotSufficientForSwap"),
          events: [],
        };
      }
      state.keyCash -= cashIn;
      state.keyPas += args.amount_out;
      return { ok: true, txHash: txHashFor(), block: { number: 499 }, events: [] };
    },
  });

  /** The XCM as People runs it: the pool refuses it unless the fee leaves the existential deposit
   *  in place, the fee comes off the PAS first, WithdrawAsset needs both amounts on the key, and
   *  the allowance must cover the charge for the message actually forwarded. */
  const executeTx = (args: ExecuteArgs) => ({
    decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } },
    getEstimatedFees: async () => XCM_TX_FEE_PAS,
    signAndSubmit: async (_signer: unknown, options: Record<string, unknown>) => {
      state.submits.push({ call: "execute", args, options });
      if (state.keyPas - XCM_TX_FEE_PAS < ED) {
        throw new Error(JSON.stringify({ type: "Invalid", value: { type: "Payment" } }));
      }
      state.keyPas -= XCM_TX_FEE_PAS;
      const [pasWithdrawn, cashWithdrawn] = withdrawnOf(args.message);
      const short =
        pasWithdrawn!.fun.value > state.keyPas || cashWithdrawn!.fun.value > state.keyCash;
      if (short || opts.rejectXcm) {
        return {
          ok: false,
          txHash: txHashFor(),
          dispatchError: incomplete(
            short ? 0 : 2,
            short ? "FailedToTransactAsset" : opts.rejectXcm!,
          ),
          events: [],
        };
      }
      state.keyCash -= cashWithdrawn!.fun.value;
      state.keyPas -= pasWithdrawn!.fun.value;
      // Below the existential deposit the account is reaped and its PAS is dust.
      if (state.keyPas < ED) {
        state.dustLost += state.keyPas;
        state.keyPas = 0n;
      }
      state.xcmLanded = true;
      state.xcmTo = beneficiaryOf(
        (args.message.value[2]!.value as { remote_xcm: Instruction[] }).remote_xcm,
      );
      // A program aimed at the key lands its CASH there at once; the destination's reads below
      // pace a landing aimed at it.
      if (state.xcmTo === KEY.publicKeyHex) state.keyCashAh += state.lastDryRunLanded;
      if (opts.loseXcmAnswer) throw new Error("withdrawal submit timed out after 1s");
      return { ok: true, txHash: txHashFor(), block: { number: 500 }, events: [] };
    },
  });

  const peopleApi = {
    constants: { Balances: { ExistentialDeposit: async () => ED } },
    query: {
      System: {
        Account: {
          getValue: async (who: string) => ({
            data: { free: who === PASEO_PEOPLE_POOL_ACCOUNT ? RESERVES.pas : state.keyPas },
          }),
        },
      },
      Assets: {
        Account: {
          getValue: async (_asset: unknown, who: string) => ({
            balance: who === PASEO_PEOPLE_POOL_ACCOUNT ? RESERVES.cash : state.keyCash,
          }),
        },
      },
    },
    apis: {
      XcmPaymentApi: {
        query_xcm_weight: async () => ({ success: true, value: WEIGHED }),
        query_delivery_fees: async (_dest: unknown, message: Message) => ({
          success: true,
          value: {
            type: "V5",
            value: [{ fun: { type: "Fungible", value: DELIVERY[assetsCount(message) as 1 | 2] } }],
          },
        }),
      },
      DryRunApi: {
        // No fee is charged in a dry run; the withdrawn amounts must be on the key and the
        // unspent allowance is trapped.
        dry_run_call: async (_origin: unknown, call: { value: { value: ExecuteArgs } }) => {
          state.dryRuns += 1;
          const message = call.value.value.message;
          const [pasWithdrawn, cashWithdrawn] = withdrawnOf(message);
          if (pasWithdrawn!.fun.value > state.keyPas || cashWithdrawn!.fun.value > state.keyCash) {
            return rejectedExecution(incomplete(0, "FailedToTransactAsset"));
          }
          const forwarded = forwardedFor(message);
          const charge = LOCAL + DELIVERY[assetsCount(forwarded) as 1 | 2];
          const payFees = payFeesOf(message);
          if (payFees < charge) return rejectedExecution(incomplete(2, "NotHoldingFees"));
          const surplus = payFees - charge;
          return {
            success: true,
            value: {
              execution_result: { success: true, value: {} },
              emitted_events: surplus > 0n ? [trappedEvent(surplus)] : [],
              forwarded_xcms: [
                [
                  {
                    type: "V5",
                    value: {
                      parents: 1,
                      interior: { type: "X1", value: { type: "Parachain", value: 1500 } },
                    },
                  },
                  [forwarded],
                ],
              ],
            },
          };
        },
      },
    },
    tx: {
      AssetConversion: { swap_tokens_for_exact_tokens: swapTx },
      PolkadotXcm: { execute: executeTx },
    },
  };

  /** A call of the key's on Asset Hub, applied to the scripted chain: the PSM redeems against
   *  its debt unless scripted to refuse, the sweep moves the key's stable, the pool pays its
   *  rate, and a batch reverts whole on the first error. Returns the dispatch error, if any. */
  const apply = (call: Call): unknown => {
    const name = `${call.type}.${call.value.type}`;
    if (name === "Utility.batch_all") {
      const before = { ...state };
      for (const inner of (call.value.value as { calls: Call[] }).calls) {
        const error = apply(inner);
        if (error) {
          Object.assign(state, before);
          return error;
        }
      }
      return null;
    }
    if (name === "Psm.redeem") {
      const { internal_amount, max_fee } = call.value.value as RedeemArgs;
      const out = psmRedeemOut(internal_amount, max_fee);
      if (opts.refuseRedeem) return moduleError("Psm", opts.refuseRedeem);
      if (internal_amount < PSM_MIN_SWAP) return moduleError("Psm", "BelowMinimumSwap");
      if (state.psmDebt < out) return moduleError("Psm", "InsufficientReserve");
      state.keyCashAh -= internal_amount;
      state.keyUsdtAh += out;
      state.psmDebt -= internal_amount;
      return null;
    }
    if (name === "Assets.transfer_all") {
      if ((call.value.value as TransferAllArgs).dest.value === DESTINATION_SS58) {
        state.destinationPas += state.keyUsdtAh;
        state.keyUsdtAh = 0n;
      }
      return null;
    }
    if (name === "AssetConversion.swap_exact_tokens_for_tokens") {
      const { amount_in, amount_out_min, send_to } = call.value.value as ExitSwapArgs;
      const out = (amount_in * AH_RATE) / STABLE_PLANCK;
      if (out < amount_out_min) {
        return moduleError("AssetConversion", "ProvidedMinimumNotSufficientForSwap");
      }
      state.keyCashAh -= amount_in;
      if (send_to === DESTINATION_SS58) state.destinationPas += out;
      else state.keyUsdtAh += out;
      return null;
    }
    throw new Error(`unscripted call ${name}`);
  };

  /** A transaction of the key's on Asset Hub: the fee comes off its CASH first. */
  const assetHubTx = (pallet: string, name: string, args: unknown) => {
    const decodedCall: Call = { type: pallet, value: { type: name, value: args } };
    return {
      decodedCall,
      getEstimatedFees: async () => AH_TX_FEE_PAS,
      signAndSubmit: async (_signer: unknown, options: Record<string, unknown>) => {
        state.submits.push({ call: name, args, options });
        state.keyCashAh -= AH_TX_FEE_CASH;
        const dispatchError = apply(decodedCall);
        if (dispatchError) return { ok: false, txHash: txHashFor(), dispatchError, events: [] };
        return { ok: true, txHash: txHashFor(), block: { number: 501 }, events: [] };
      },
    };
  };

  const assetHubApi = {
    tx: {
      Psm: { redeem: (args: unknown) => assetHubTx("Psm", "redeem", args) },
      Assets: { transfer_all: (args: unknown) => assetHubTx("Assets", "transfer_all", args) },
      Utility: { batch_all: (args: unknown) => assetHubTx("Utility", "batch_all", args) },
      AssetConversion: {
        swap_exact_tokens_for_tokens: (args: unknown) =>
          assetHubTx("AssetConversion", "swap_exact_tokens_for_tokens", args),
      },
    },
    query: {
      Psm: {
        PsmDebt: { getValue: async () => state.psmDebt },
        Psm: { getValue: async () => ({ min_swap_amount: PSM_MIN_SWAP }) },
      },
      Assets: {
        Asset: {
          getValue: async (id: number) => ({
            min_balance: id === TOKENS.CASH.assetHubId ? CASH_MIN_BALANCE : USDT_MIN_BALANCE,
          }),
        },
      },
    },
    apis: {
      AssetConversionApi: {
        // CASH, local to Asset Hub, sells for the native; the native sells for a stable.
        quote_price_exact_tokens_for_tokens: async (
          give: { parents: number },
          _want: unknown,
          amountIn: bigint,
        ) => (give.parents === 0 ? amountIn * AH_RATE : amountIn / STABLE_PLANCK),
        // The CASH an exact amount of the native costs: the fee priced for the key.
        quote_price_tokens_for_exact_tokens: async (
          _give: unknown,
          _want: unknown,
          amountOut: bigint,
        ) => amountOut / AH_RATE,
      },
      DryRunApi: {
        // The key's call, run and undone.
        dry_run_call: async (_origin: unknown, call: Call) => {
          state.exitDryRuns += 1;
          const before = { ...state };
          const error = apply(call);
          Object.assign(state, before);
          return error
            ? rejectedExecution(error)
            : { success: true, value: { execution_result: { success: true, value: {} } } };
        },
        // Asset Hub runs the sale the program asks: every CASH for PAS on one hop, every PAS for
        // the stable on two, nothing sold on none; then deposits the holding to the beneficiary.
        dry_run_xcm: async (_origin: unknown, forwarded: Message) => {
          const travelling = forwarded.value[2]!.value as Fungible[];
          const earmark = (forwarded.value[0]!.value as Fungible[])[0]!.fun.value;
          const pas = travelling.length === 2 ? travelling[0]!.fun.value : 0n;
          const cash = travelling[travelling.length - 1]!.fun.value + earmark - AH_FEE_CASH;
          const hops = forwarded.value.filter((i) => i.type === "ExchangeAsset");
          const native = pas + cash * AH_RATE;
          const who = ss58Of(beneficiaryOf(forwarded.value.slice(0, -1)));
          let events: unknown[];
          if (givesNative(hops[0])) {
            // The dotUSD and PSM tiers: the PAS is sold for CASH and the CASH lands as it is.
            state.lastDryRunLanded = cash + pas / AH_RATE;
            events = [deposited(TOKENS.CASH.assetHubId, state.lastDryRunLanded, who)];
          } else if (hops.length === 1) {
            state.lastDryRunLanded = native;
            events = [deposited(null, native, who)];
          } else {
            const want = (hops[1]!.value as Exchange).want[0]!.id as AssetLocation;
            state.lastDryRunLanded = native / STABLE_PLANCK;
            events = [
              deposited(Number(want.interior.value[1]!.value), state.lastDryRunLanded, who),
            ];
          }
          if (opts.trapOnAssetHubDryRun) events.push(trappedEvent(opts.trapOnAssetHubDryRun));
          return {
            success: true,
            value: {
              execution_result: { type: "Complete", value: { used: {} } },
              emitted_events: events,
            },
          };
        },
      },
    },
  };

  /** The destination's balance in the landing asset at the head: what an XCM aimed at it lands
   *  shows after `arrivalAfterReads` reads. */
  const readDestinationOnAssetHub = async () => {
    if (state.xcmLanded && !state.pasLanded && state.xcmTo === DESTINATION_HEX) {
      state.destinationReads += 1;
      if (state.destinationReads >= (opts.arrivalAfterReads ?? 1)) {
        state.destinationPas += state.lastDryRunLanded - (opts.landShort ?? 0n);
        state.pasLanded = true;
      }
    }
    return state.destinationPas;
  };

  const readKeyOnAssetHub = async () => ({ cash: state.keyCashAh, usdt: state.keyUsdtAh });

  return { state, peopleApi, assetHubApi, readDestinationOnAssetHub, readKeyOnAssetHub };
}

type World = ReturnType<typeof scriptedWorld>;

async function drive(
  world: World,
  ticks: number,
  state: WithdrawTickState = freshWithdrawTickState(),
  sale: ConversionRoute = { tier: "pool" },
  destinationHex = DESTINATION_HEX,
) {
  const steps: WithdrawStep[] = [];
  const outcomes: WithdrawTickOutcome[] = [];
  const transients: string[] = [];
  let now = 1_000;
  for (let tick = 0; tick < ticks; tick += 1) {
    now += 1_000;
    const outcome = await withdrawTickOnce(
      {
        peopleApi: world.peopleApi as never,
        assetHubApi: world.assetHubApi as never,
        key: KEY,
        destinationHex,
        assetHubParaId: 1500,
        peopleParaId: 1502,
        poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
        sale,
        slippagePct: 5,
        transfer: "teleport",
        tickTimeoutMs: 1_000,
        submitTimeoutMs: 1_000,
        readKeyOnPeople: async () => ({ cash: world.state.keyCash, pas: world.state.keyPas }),
        readKeyOnAssetHub: world.readKeyOnAssetHub,
        readDestinationOnAssetHub: world.readDestinationOnAssetHub,
        now: () => now,
        onTransientError: (e) => transients.push(e instanceof Error ? e.message : String(e)),
      },
      state,
    );
    steps.push(outcome.step);
    outcomes.push(outcome);
    if (outcome.step === "done") break;
  }
  return { steps, outcomes, state, transients };
}

/** The exit the tick sizes from what the key holds on Asset Hub now: the CASH less the fee's
 *  margin and the account's minimum, and the net the PSM pays for it. */
const sizedExit = (world: World) => {
  const cashIn = world.state.keyCashAh - withFeeMargin(AH_TX_FEE_CASH) - CASH_MIN_BALANCE;
  return { cashIn, net: psmRedeemOut(cashIn, PSM_FEE_RATE) };
};

const submitsOf = (world: World) => ({
  swap: world.state.submits.find((s) => s.call === "swap"),
  execute: world.state.submits.find((s) => s.call === "execute"),
});

/** The XCM that went out: the CASH it withdrew, its earmark, whether the key's origin travels,
 *  and the program Asset Hub runs. */
function sentXcm(world: World) {
  const message = (submitsOf(world).execute!.args as ExecuteArgs).message;
  const transfer = message.value[2]!.value as {
    remote_fees: { value: { value: Fungible[] } };
    preserve_origin: boolean;
    remote_xcm: Instruction[];
  };
  const [pasWithdrawn, cashWithdrawn] = message.value[0]!.value as Fungible[];
  const payFees = (message.value[1]!.value as { asset: Fungible }).asset.fun.value;
  return {
    cashSold: cashWithdrawn!.fun.value,
    pasTravelling: pasWithdrawn!.fun.value - payFees,
    earmark: transfer.remote_fees.value.value[0]!.fun.value,
    preserveOrigin: transfer.preserve_origin,
    program: transfer.remote_xcm,
  };
}

describe("withdrawTickOnce", () => {
  it("waits for CASH, swaps, then sizes, proves and submits the XCM, then reads the destination to done", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 2 });
    world.state.keyCash = 0n;
    const idle = await drive(world, 1);
    expect(idle.steps).toEqual(["await-cash"]);
    expect(idle.state.fundsSeenAt).toBeNull();

    world.state.keyCash = KEY_CASH;
    const run = await drive(world, 6, idle.state);
    expect(run.steps).toEqual(["swap", "convert", "await-arrival", "done"]);
    expect(run.state).toMatchObject({
      attempts: 2,
      rejections: 0,
      submitted: true,
      // The baseline is what the destination held before the XCM; the landing is the dry run's.
      destinationBefore: DESTINATION_PAS,
      expectedLanding: world.state.lastDryRunLanded,
    });
    expect(run.state.fundsSeenAt).toBe(2_000);
    expect(run.transients).toEqual([]);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + world.state.lastDryRunLanded);
  });

  it("sells for a stable in two hops, each held to its floor, and reads the arrival in that asset", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 3, freshWithdrawTickState(), {
      tier: "pool",
      external: "USDC",
    });
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    const { cashSold, program } = sentXcm(world);
    const hops = program.filter((i) => i.type === "ExchangeAsset");
    expect(hops).toHaveLength(2);
    // The native floor is the sale's quote less the headroom; the stable's is the two hop quote
    // less the same headroom, so the hops share it.
    const nativeQuote = cashSold * AH_RATE;
    expect((hops[0]!.value as Exchange).want[0]!.fun.value).toBe((nativeQuote * 95n) / 100n);
    expect((hops[1]!.value as Exchange).want[0]!.fun.value).toBe(
      ((nativeQuote / STABLE_PLANCK) * 95n) / 100n,
    );
    // What the dry run said lands is in USDC units, read from the USDC deposit, and the
    // destination's USDC holding is what grew by it.
    expect(run.state.expectedLanding).toBe(world.state.lastDryRunLanded);
    expect(run.state.expectedLanding).toBeLessThan(nativeQuote / 1_000n);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + world.state.lastDryRunLanded);
  });

  it("lands the CASH on the key's own Asset Hub account on the PSM tier, then redeems it there once the PSM has room for the net, the stable sent on in the same batch", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    const toKey = await drive(world, 2, state, PSM_SALE);
    expect(toKey.steps).toEqual(["swap", "convert"]);
    // The dotUSD program aimed at the key, with no origin kept; no baseline yet, the XCM lands
    // nothing on the destination.
    const { preserveOrigin, program } = sentXcm(world);
    expect(preserveOrigin).toBe(false);
    expect(program.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    expect(beneficiaryOf(program)).toBe(KEY.publicKeyHex);
    expect(state).toMatchObject({
      submitted: true,
      destinationBefore: null,
      expectedLanding: null,
    });
    expect(world.state.keyCashAh).toBe(world.state.lastDryRunLanded);

    // Room for exactly the redeem's net is enough.
    const { cashIn, net } = sizedExit(world);
    world.state.psmDebt = net;
    const run = await drive(world, 2, state, PSM_SALE);
    expect(run.steps).toEqual(["redeem", "done"]);
    expect(run.outcomes[0]).toMatchObject({ submitted: true });
    const batch = world.state.submits[2]!;
    expect(batch.call).toBe("batch_all");
    expect(batch.args).toEqual({
      calls: [
        {
          type: "Psm",
          value: {
            type: "redeem",
            value: {
              internal_asset: TOKENS.CASH.location,
              external_asset: TOKENS.USDT.location,
              internal_amount: cashIn,
              max_fee: PSM_FEE_RATE,
            },
          },
        },
        {
          type: "Assets",
          value: {
            type: "transfer_all",
            value: { id: 1984, dest: { type: "Id", value: DESTINATION_SS58 }, keep_alive: false },
          },
        },
      ],
    });
    expect(batch.options).toEqual({ asset: TOKENS.CASH.location });
    expect(state).toMatchObject({
      attempts: 3,
      exit: "psm",
      redeemSubmitted: true,
      waitingSince: null,
      psmRefusals: 0,
      destinationBefore: DESTINATION_PAS,
      expectedLanding: net,
    });
    // The destination gained the net exactly; the key keeps its CASH account alive with the
    // minimum and the fee margin's unspent part.
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + net);
    expect(world.state.keyUsdtAh).toBe(0n);
    expect(world.state.keyCashAh).toBe(
      CASH_MIN_BALANCE + withFeeMargin(AH_TX_FEE_CASH) - AH_TX_FEE_CASH,
    );
  });

  it("waits while the PSM is short of the redeem's net, dry-running, submitting and counting nothing, and redeems once it has room", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state, PSM_SALE);
    const { net } = sizedExit(world);
    world.state.psmDebt = net - 1n;
    const short = await drive(world, 1, state, PSM_SALE);
    expect(short.outcomes[0]).toMatchObject({ step: "redeem", submitted: false, waiting: true });
    expect(state).toMatchObject({
      waitingSince: 2_000,
      attempts: 2,
      psmRefusals: 0,
      redeemSubmitted: false,
    });
    expect(world.state.exitDryRuns).toBe(0);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);

    world.state.psmDebt = net;
    const fits = await drive(world, 1, state, PSM_SALE);
    expect(fits.outcomes[0]).toMatchObject({ step: "redeem", submitted: true });
    expect(state).toMatchObject({ waitingSince: null, attempts: 3, redeemSubmitted: true });
  });

  it("waits, counting nothing, when the dry run finds the room gone meanwhile", async () => {
    const world = scriptedWorld({ refuseRedeem: "InsufficientReserve" });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, PSM_SALE);
    world.state.psmDebt = sizedExit(world).net;
    const run = await drive(world, 1, state, PSM_SALE);
    expect(run.outcomes[0]).toMatchObject({ step: "redeem", submitted: false, waiting: true });
    expect(state).toMatchObject({
      waitingSince: 2_000,
      psmRefusals: 0,
      redeemSubmitted: false,
      destinationBefore: null,
    });
    expect(world.state.exitDryRuns).toBe(1);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);
  });

  it("counts a refusal the pair's pause explains towards the hold, and holds the run on the third with nothing spent", async () => {
    const world = scriptedWorld({ refuseRedeem: "AllSwapsStopped" });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, PSM_SALE);
    world.state.psmDebt = sizedExit(world).net;
    for (let refusal = 1; refusal < MAX_PSM_REFUSALS; refusal += 1) {
      await expect(drive(world, 1, state, PSM_SALE)).rejects.toThrow(
        /redeem refused: Psm.AllSwapsStopped/,
      );
      expect(state.psmRefusals).toBe(refusal);
    }
    await expect(drive(world, 1, state, PSM_SALE)).rejects.toThrow(
      /withdrawal held: the PSM refused the redeem 3 times, last: Psm.AllSwapsStopped/,
    );
    await expect(drive(world, 1, state, PSM_SALE)).rejects.toBeInstanceOf(WithdrawHeldError);
    expect(state).toMatchObject({ waitingSince: null, redeemSubmitted: false });
    expect(world.state.keyCashAh).toBe(world.state.lastDryRunLanded);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);
  });

  it("holds at once on a refusal no retry can clear", async () => {
    const world = scriptedWorld({ refuseRedeem: "FeeTooHigh" });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, PSM_SALE);
    world.state.psmDebt = sizedExit(world).net;
    await expect(drive(world, 1, state, PSM_SALE)).rejects.toThrow(
      /withdrawal held: the PSM will not redeem as quoted: Psm.FeeTooHigh/,
    );
    await expect(drive(world, 1, state, PSM_SALE)).rejects.toBeInstanceOf(WithdrawHeldError);
    expect(state).toMatchObject({ psmRefusals: 0, redeemSubmitted: false });
    expect(world.state.keyCashAh).toBe(world.state.lastDryRunLanded);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);
  });

  it("sells the CASH on the pool from the key once the user chose it, the stable paid to the destination", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state, PSM_SALE);
    state.exit = "pool";
    const { cashIn } = sizedExit(world);
    const quote = (cashIn * AH_RATE) / STABLE_PLANCK;
    const minOut = (quote * 95n) / 100n;
    const run = await drive(world, 2, state, PSM_SALE);
    expect(run.steps).toEqual(["redeem", "done"]);
    const swap = world.state.submits[2]!;
    expect(swap.call).toBe("swap_exact_tokens_for_tokens");
    expect(swap.args).toEqual({
      path: [TOKENS.CASH.location, TOKENS.PAS.location, TOKENS.USDT.location],
      amount_in: cashIn,
      amount_out_min: minOut,
      send_to: DESTINATION_SS58,
      keep_alive: false,
    });
    expect(swap.options).toEqual({ asset: TOKENS.CASH.location });
    // Held to the quote less the headroom; the destination gained the quote itself.
    expect(state).toMatchObject({ expectedLanding: minOut, redeemSubmitted: true });
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + quote);
    expect(world.state.psmDebt).toBe(0n);
  });

  it("redeems alone for a provider rail, the stable staying on the key as the landing", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state, PSM_SALE, KEY.publicKeyHex);
    const { cashIn, net } = sizedExit(world);
    world.state.psmDebt = net;
    const run = await drive(world, 2, state, PSM_SALE, KEY.publicKeyHex);
    expect(run.steps).toEqual(["redeem", "done"]);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute", "redeem"]);
    expect(world.state.submits[2]!.args).toMatchObject({
      internal_amount: cashIn,
      max_fee: PSM_FEE_RATE,
    });
    expect(state).toMatchObject({ destinationBefore: 0n, expectedLanding: net });
    expect(world.state.keyUsdtAh).toBe(net);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS);
  });

  it("lands the CASH as dotUSD on the dotUSD tier, with the PAS that travelled sold for it", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 3, freshWithdrawTickState(), { tier: "dotusd" });
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    const { cashSold, pasTravelling, program } = sentXcm(world);
    expect(program.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    // The landing is the CASH itself less Asset Hub's fee, the earmark's unspent part back in,
    // plus what the PAS sold for; nothing lands as PAS.
    expect(run.state.expectedLanding).toBe(cashSold - AH_FEE_CASH + pasTravelling / AH_RATE);
    expect(world.state.keyCash).toBe(0n);
  });

  it("prices the fees a direct withdrawal takes before the sale from People's pool, for the summary", async () => {
    const world = scriptedWorld();
    const fees = await estimateDirectFeesCash({
      peopleApi: world.peopleApi as never,
      address: KEY.address,
      poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
      assetHubParaId: 1500,
      peopleParaId: 1502,
      sale: { tier: "pool" },
      transfer: "teleport",
    });
    // The swap for the deposit and the reserve, the swap's own fee, and Asset Hub's buffer, the
    // first two priced in CASH through the pool. Nothing was submitted to learn it.
    expect(fees).toBe(
      cashInFor(ED + RESERVE, RESERVES) +
        cashInFor(SWAP_TX_FEE_PAS, RESERVES) +
        ASSET_HUB_FEE_BUFFER_CASH,
    );
    expect(world.state.submits).toEqual([]);
  });

  it("keeps waiting while the destination gained less than the landing floor", async () => {
    const world = scriptedWorld({ landShort: 20_000_000_000n });
    const run = await drive(world, 4);
    expect(run.steps).toEqual(["swap", "convert", "await-arrival", "await-arrival"]);
    expect(landingFloor(100n, 5)).toBe(95n);
    expect(landingFloor(1_000n, 0.5)).toBe(995n);
  });

  it("leaves no CASH: the XCM withdraws the whole balance read after the swap, and only PAS dust stays", async () => {
    const world = scriptedWorld();
    await drive(world, 2);
    const { swap, execute } = submitsOf(world);
    const swapArgs = swap!.args as SwapArgs;
    const message = (execute!.args as ExecuteArgs).message;
    const [pasWithdrawn, cashWithdrawn] = message.value[0]!.value as Fungible[];
    const payFees = (message.value[1]!.value as { asset: Fungible }).asset.fun.value;

    // The swap buys the existential deposit plus the XCM's fee reserve, allowed to spend a little
    // over the quote.
    expect(swapArgs.amount_out).toBe(ED + RESERVE);
    expect(swapArgs.amount_in_max).toBe(
      (cashInFor(ED + RESERVE, RESERVES) * BigInt(100 + SWAP_HEADROOM_PCT)) / 100n,
    );
    // The XCM took every CASH left after the swap and its fee.
    expect(cashWithdrawn!.fun.value).toBe(
      KEY_CASH - SWAP_FEE_CASH - cashInFor(ED + RESERVE, RESERVES),
    );
    expect(world.state.keyCash).toBe(0n);
    // And all the PAS but the reserve, whose unspent part is the only dust, reaped with the key.
    expect(pasWithdrawn!.fun.value).toBe(ED);
    expect(world.state.keyPas).toBe(0n);
    expect(world.state.dustLost).toBe(RESERVE - XCM_TX_FEE_PAS);
    expect(world.state.dustLost).toBeLessThan(ED);
    // Exactly what People charges for the two-asset message, no more.
    expect(payFees).toBe(LOCAL + DELIVERY[2]);
    // The weight ceiling is the weighed weight, so nothing is refunded after the key is emptied.
    expect((execute!.args as ExecuteArgs).max_weight).toEqual(WEIGHED);
  });

  it("pays the swap in CASH and the XCM in PAS, both with People's signed extension", async () => {
    const world = scriptedWorld();
    await drive(world, 2);
    const { swap, execute } = submitsOf(world);
    const extension = { VerifyMultiSignature: { value: { type: "Disabled" } } };
    expect(swap!.options).toMatchObject({
      asset: expect.anything(),
      customSignedExtensions: extension,
    });
    expect(execute!.options).toMatchObject({ customSignedExtensions: extension });
    expect(execute!.options).not.toHaveProperty("asset");
  });

  it("swaps again when the PAS on the key cannot pay the XCM's fee and keep the deposit", async () => {
    const world = scriptedWorld();
    // The existential deposit alone: the pool would refuse the fee charge.
    world.state.keyPas = ED;
    const run = await drive(world, 3);
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    expect(run.transients[0]).toMatch(/the key holds .* PAS and the XCM needs/);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);
    expect(world.state.keyCash).toBe(0n);
    expect(world.state.keyPas).toBe(0n);
  });

  it("names the failing instruction on a rejected XCM, retries with fresh sizing, and gives up after the cap", async () => {
    const world = scriptedWorld({ rejectXcm: "NoDeal" });
    // Enough PAS that no rejection sends the run back to the swap.
    world.state.keyPas = 3n * ED;
    const state = freshWithdrawTickState();
    for (let rejection = 1; rejection < MAX_REJECTIONS; rejection += 1) {
      await expect(drive(world, 1, state)).rejects.toThrow(
        /withdraw rejected: InitiateTransfer failed with NoDeal/,
      );
      expect(state).toMatchObject({ rejections: rejection, submitted: false });
    }
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(WithdrawRejectedError);
    expect(state.attempts).toBe(MAX_REJECTIONS);
    // Each rejection cost the transaction fee in PAS; the CASH never moved.
    expect(world.state.keyPas).toBe(3n * ED - BigInt(MAX_REJECTIONS) * XCM_TX_FEE_PAS);
    expect(world.state.keyCash).toBe(KEY_CASH);
  });

  it("finishes when the XCM emptied the key but its answer was lost: the baseline read before the submit still measures the arrival", async () => {
    const world = scriptedWorld({ loseXcmAnswer: true });
    const state = freshWithdrawTickState();
    await drive(world, 1, state);
    await expect(drive(world, 1, state)).rejects.toThrow(/timed out/);
    expect(state).toMatchObject({
      attempts: 2,
      submitted: false,
      destinationBefore: DESTINATION_PAS,
      expectedLanding: world.state.lastDryRunLanded,
    });
    expect(world.state.keyCash).toBe(0n);
    // An empty key after a submit is not an unpaid key; the next tick reads the destination.
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "done"]);
    expect(state.submitted).toBe(true);
  });

  it("holds in await-arrival when the baseline was lost with the state", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state);
    state.destinationBefore = null;
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "await-arrival"]);
    expect(world.state.destinationReads).toBe(0);
  });

  it("does not count a deposit from elsewhere as the arrival while the key still holds funds", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    state.submitted = true;
    state.fundsSeenAt = 1_000;
    state.destinationBefore = DESTINATION_PAS;
    state.expectedLanding = 5n * ED;
    // A stranger pays the destination while the key, unspent, still holds its CASH.
    world.state.destinationPas = DESTINATION_PAS + 5n * ED;
    const waiting = await drive(world, 1, state);
    expect(waiting.steps).toEqual(["await-arrival"]);
    // The XCM took the CASH; PAS dust the reaping missed does not hold the run.
    world.state.keyCash = 0n;
    world.state.keyPas = 1n;
    const done = await drive(world, 1, state);
    expect(done.steps).toEqual(["done"]);
  });

  it("refuses to submit the XCM when the Asset Hub dry run would trap assets", async () => {
    const world = scriptedWorld({ trapOnAssetHubDryRun: 7n });
    const state = freshWithdrawTickState();
    await drive(world, 1, state);
    await expect(drive(world, 1, state)).rejects.toThrow(/would trap 7 on Asset Hub/);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap"]);
    expect(world.state.keyPas).toBe(ED + RESERVE);
  });
});
