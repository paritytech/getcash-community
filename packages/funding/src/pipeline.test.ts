// Offline coverage over a scripted chain: the step decision, single ticks of the funding program
// on either tier, pool discovery, the quote headroom, the deposit sizing, the dispatch-error
// decoder, and the manual rail.

import { TOKENS } from "@getsome/core";
import { AccountId, type PolkadotClient } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { describeDispatchError } from "./dispatch-error";
import { createManualRail } from "./manual-rail";
import { destinationEarmark, estimateDestinationFeeCash, withFeeMargin } from "./funding-program";
import {
  decideStep,
  DEFAULT_SLIPPAGE_PCT,
  discoverPool,
  freshTickState,
  FundingHeldError,
  FundingShortfallError,
  MAX_PSM_REFUSALS,
  psmDepositNeeded,
  quoteNativeIn,
  quoteNativeInMax,
  sizeNativeBudget,
  tickOnce,
  type FundingStep,
  type TickState,
} from "./pipeline";
import { psmMintOut, sizePsmMint, type PsmRoute } from "./psm-batch";
import type { ConversionRoute } from "./route";

const SETTLE = 5_000_000n; // 5 underlying at 6 decimals
const BUFFER = 100_000n;
const BUY = SETTLE + BUFFER;
const QUOTED = 1_281_000_000n; // native the pool quotes for BUY
const MAX_IN = (QUOTED * 10_200n) / 10_000n; // +2%, the headroom `drive` passes
/** What the page asks for at the default headroom: the quote plus DEFAULT_SLIPPAGE_PCT. */
const ASK = (QUOTED * BigInt(10_000 + DEFAULT_SLIPPAGE_PCT * 100)) / 10_000n;

// The scripted runtime's fee answers for the funding program.
const DISPATCH = 1_000n; // the execute() dispatch fee, native
const LOCAL_FEE = 100n; // query_weight_to_asset_fee for the measured weight
const DELIVERY = 0n; // query_delivery_fees
const PAYFEES = LOCAL_FEE + DELIVERY; // the pool tier's allowance is exact
/** Native the funding program spends on itself. */
const OVERHEAD = DISPATCH + PAYFEES;
/** The sizing's fee native: what a live estimate reports, exactly the funding program's own costs.
 *  Anything the deposit carries above this is converted, so the figure shapes what lands. */
const KEEP = OVERHEAD;
/** An over-funded burner. */
const FUND = QUOTED + MAX_IN + KEEP;
const EARMARK = destinationEarmark(BUY, BUFFER);
const SIGN_OPTIONS = { at: "0xbest" };
const ASSET_HUB_PARA = 1500;
const PEOPLE_PARA = 1004;
const POOL: ConversionRoute = { tier: "pool" };

// The PSM tier: the same target from a USDT deposit, at 0.5%.
const ROUTE: PsmRoute = { tier: "psm", external: "USDT", feeRate: 5_000 };
/** The batch's dispatch fee as ChargeAssetTxPayment charges it: the pool's USDT price for DISPATCH. */
const DISPATCH_USDT = 7_000n;
/** The scripted runtime's answers for the PSM program's own fees, in USDT. */
const LOCAL_USDT = 90n;
const DELIVERY_USDT = 10n;
const FEES_USDT = LOCAL_USDT + DELIVERY_USDT;
/** The PSM tier's fee allowance: the measured fees and the margin the program refunds. */
const ALLOWANCE = withFeeMargin(FEES_USDT);
/** USDt's min_balance as the scripted chain has it; the burner keeps this much through the batch. */
const MIN_BALANCE = 70_000n;
/** Kept out of the mint beside the dispatch fee: the min_balance and the fee allowance. */
const HELD_BACK = MIN_BALANCE + ALLOWANCE;
/** The USDT the tier needs on the burner: the mint that pays out exactly the target, plus the
 *  dispatch fee and what stays out of the mint. */
const PSM_DEPOSIT = sizePsmMint(BUY, ROUTE).externalIn + DISPATCH_USDT + HELD_BACK;

/** The burner on People, as the program names it and as People's events show it. */
const BENEFICIARY = new Uint8Array(32).fill(7);
const BENEFICIARY_HEX = `0x${"07".repeat(32)}`;
const BENEFICIARY_SS58 = AccountId(42).dec(BENEFICIARY);
const FEE_RECEIVER_SS58 = AccountId(42).dec(new Uint8Array(32).fill(9));

const NATIVE_LOC = { parents: 1, interior: { type: "Here" } };
const UNDERLYING_LOC = {
  parents: 0,
  interior: {
    type: "X2",
    value: [
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: 50_000_413n },
    ],
  },
};

describe("decideStep", () => {
  const targets = { settleAmount: SETTLE, depositNeeded: QUOTED + KEEP };
  it("done once the underlying reached People, and not one base unit sooner", () => {
    expect(decideStep({ depositAh: 0n, underlyingPeople: SETTLE }, targets)).toBe("done");
    // the partial-arrival world: the destination fee ate past the buffer
    expect(decideStep({ depositAh: 0n, underlyingPeople: SETTLE - 1n }, targets)).toBe(
      "await-native",
    );
  });
  it("converts once the deposit covers what the conversion needs, fees included, and not sooner", () => {
    expect(decideStep({ depositAh: QUOTED + KEEP, underlyingPeople: 0n }, targets)).toBe("swap");
    expect(decideStep({ depositAh: QUOTED + KEEP - 1n, underlyingPeople: 0n }, targets)).toBe(
      "await-native",
    );
  });
});

type Instruction = { type: string; value: never };
type Fungible = { id?: unknown; fun: { value: bigint } };
type ExecuteArgs = { message: { value: Instruction[] }; max_weight: unknown };

const instruction = (args: ExecuteArgs, type: string) =>
  args.message.value.find((i) => i.type === type)?.value as never;
const exchangeOf = (args: ExecuteArgs) =>
  instruction(args, "ExchangeAsset") as {
    give: { value: Fungible[] };
    want: Fungible[];
    maximal: boolean;
  };
type Transfer = { remote_fees: { value: { value: Fungible[] } }; remote_xcm: Instruction[] };
const transferOf = (args: ExecuteArgs) => instruction(args, "InitiateTransfer") as Transfer;

const incomplete = (index: number, error: string) => ({
  type: "Module",
  value: {
    type: "PolkadotXcm",
    value: {
      type: "LocalExecutionIncompleteWithError",
      value: { index, error: { type: error } },
    },
  },
});
const trapped = (amount: bigint | undefined) =>
  amount
    ? [
        {
          type: "PolkadotXcm",
          value: {
            type: "AssetsTrapped",
            value: {
              assets: { type: "V5", value: [{ fun: { type: "Fungible", value: amount } }] },
            },
          },
        },
      ]
    : [];
const fungible = (value: bigint) => ({ fun: { type: "Fungible", value } });
const toPeople = {
  type: "V5",
  value: {
    parents: 1,
    interior: { type: "X1", value: { type: "Parachain", value: PEOPLE_PARA } },
  },
};
/** What the runtime forwards for `teleported` in the holding: the fee teleport, the asset
 *  teleport, then the remote program. */
const forwardedProgram = (transfer: Transfer, teleported: bigint) => {
  const earmark = transfer.remote_fees.value.value[0]!.fun.value;
  return {
    type: "V5",
    value: [
      { type: "ReceiveTeleportedAsset", value: [fungible(earmark)] },
      { type: "PayFees", value: { asset: fungible(earmark) } },
      { type: "ReceiveTeleportedAsset", value: [fungible(teleported - earmark)] },
      { type: "ClearOrigin" },
      ...transfer.remote_xcm,
      { type: "SetTopic", value: `0x${"00".repeat(32)}` },
    ],
  };
};
/** People's side of the dry run: the teleported amounts minus the fee reach the beneficiary, or
 *  the program fails with `error()`. */
const scriptedPeople = (opts: {
  fee: () => bigint;
  error: () => string | undefined;
  trap?: bigint;
}) => ({
  apis: {
    DryRunApi: {
      dry_run_xcm: async (_origin: unknown, program: { value: Instruction[] }) => {
        const error = opts.error();
        if (error) {
          return {
            success: true,
            value: {
              execution_result: { type: "Incomplete", value: { used: {}, error: { type: error } } },
              emitted_events: [],
            },
          };
        }
        const teleported = program.value
          .filter((i) => i.type === "ReceiveTeleportedAsset")
          .reduce((sum, i) => sum + (i.value as Fungible[])[0]!.fun.value, 0n);
        const fee = opts.fee();
        const deposited = (who: string, amount: bigint) => ({
          type: "Assets",
          value: { type: "Deposited", value: { who, amount } },
        });
        return {
          success: true,
          value: {
            execution_result: { type: "Complete", value: { used: {} } },
            emitted_events: [
              deposited(BENEFICIARY_SS58, teleported - fee),
              deposited(FEE_RECEIVER_SS58, fee),
              ...trapped(opts.trap),
            ],
          },
        };
      },
    },
  },
});
/** The funding program's fee reads, scripted small. */
const xcmPaymentApi = {
  query_xcm_weight: async () => ({
    success: true,
    value: { ref_time: 1_000_000n, proof_size: 1_000n },
  }),
  query_weight_to_asset_fee: async () => ({ success: true, value: LOCAL_FEE }),
  query_delivery_fees: async () => ({
    success: true,
    value: { value: [{ fun: { type: "Fungible", value: DELIVERY } }] },
  }),
};

/** Scripted Asset Hub + People. XCM arrival is counted in People reads, not wall-clock. */
function scriptedWorld(
  opts: {
    /** What People's execution takes from the arrival. */
    remoteFee?: bigint;
    arrivalAfterReads?: number;
    /** Delay the funding program's native debit by N AH balance reads (a stale-read window). */
    staleDebitReads?: number;
    /** The most native the pool can price in one exchange; above it the exact-in quote answers
     *  `undefined`. */
    poolDepth?: bigint;
    /** Allow quotes after the XCM; a second run over the same burner quotes again. */
    quoteAfterXcm?: boolean;
    /** The runtime rejects the first N submits at the send (a fee allowance fell short). */
    rejectSubmits?: number;
    /** The pool price at inclusion, when it differs from the price the quotes saw. */
    priceAtSubmitBps?: bigint;
    /** What People's dry run charges, when it differs from what the execution takes. */
    remoteFeeAtDryRun?: bigint;
    /** Asset Hub's dry run rejects the program at InitiateTransfer with this XCM error. */
    assetHubDryRunError?: string;
    /** People's dry run fails the forwarded program with this XCM error. */
    peopleDryRunError?: string;
    /** Native the Asset Hub dry run reports trapped. */
    trapOnAssetHub?: bigint;
    /** Underlying the People dry run reports trapped. */
    trapOnPeople?: bigint;
  } = {},
) {
  const remoteFee = opts.remoteFee ?? 50_000n;
  const state = {
    /** The pool's native price for the underlying, in basis points of the sizing-time rate:
     *  10_000 is the rate the deposit was sized at, 10_300 is 3% dearer. */
    priceBps: 10_000n,
    nativeAh: 0n,
    underlyingPeople: 0n,
    inFlight: 0n,
    arrivalIn: 0, // People reads remaining until the in-flight amount credits
    pendingDebit: 0n,
    debitIn: 0, // AH balance reads remaining until the funding program's debit becomes visible
    xcmLanded: false, // a SUCCESSFUL send; a rejected submit leaves the run still quoting
    priceAtSubmitBps: opts.priceAtSubmitBps,
    quoteCalls: 0,
    txs: [] as Array<{ call: string; args: ExecuteArgs; options: unknown }>,
  };
  let rejectLeft = opts.rejectSubmits ?? 0;
  /** Native for `out` underlying at the current price. */
  const nativeFor = (out: bigint) => (((out * QUOTED) / BUY) * state.priceBps) / 10_000n;
  /** Underlying `nativeIn` buys at the current price. */
  const underlyingFor = (nativeIn: bigint) =>
    (((nativeIn * BUY) / QUOTED) * 10_000n) / state.priceBps;
  // The program as a dry run sees it: at the current price, without the debit, and without the
  // scripted rejection or the price move at inclusion, which only the real submit meets.
  const dryRunCall = (args: ExecuteArgs) => {
    const exchange = exchangeOf(args);
    const give = exchange.give.value[0]!.fun.value;
    const want = exchange.want[0]!.fun.value;
    const rejected = (index: number, error: string) => ({
      success: true,
      value: {
        execution_result: { success: false, value: { error: incomplete(index, error) } },
        emitted_events: [],
        forwarded_xcms: [],
      },
    });
    if (opts.assetHubDryRunError) return rejected(3, opts.assetHubDryRunError);
    const out = underlyingFor(give);
    if (out < want) return rejected(2, "NoDeal");
    return {
      success: true,
      value: {
        execution_result: { success: true, value: {} },
        emitted_events: trapped(opts.trapOnAssetHub),
        forwarded_xcms: [[toPeople, [forwardedProgram(transferOf(args), out)]]],
      },
    };
  };
  const peopleApi = scriptedPeople({
    fee: () => opts.remoteFeeAtDryRun ?? remoteFee,
    error: () => opts.peopleDryRunError,
    trap: opts.trapOnPeople,
  });
  // The program as the runtime runs it. The dispatch fee is charged whatever happens. On success
  // the withdrawn native leaves in full, the exchange fills at the pool rate and the result goes in
  // flight to People minus the destination fee. A rejection rolls the program back and only the
  // dispatch fee is gone. Nothing ever credits an AH underlying account.
  const execute = (args: ExecuteArgs) => ({
    decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } },
    getEstimatedFees: async () => DISPATCH,
    signAndSubmit: async (_signer: unknown, options: unknown) => {
      state.txs.push({ call: "swap", args, options });
      const txHash = `0x${state.txs.length.toString(16).padStart(64, "0")}`;
      const withdraw = (instruction(args, "WithdrawAsset") as Fungible[])[0]!.fun.value;
      const exchange = exchangeOf(args);
      const give = exchange.give.value[0]!.fun.value;
      const want = exchange.want[0]!.fun.value;
      if (rejectLeft > 0) {
        rejectLeft -= 1;
        state.nativeAh -= DISPATCH;
        return { ok: false, txHash, dispatchError: incomplete(3, "FeesNotMet") };
      }
      if (state.priceAtSubmitBps !== undefined) state.priceBps = state.priceAtSubmitBps;
      const out = underlyingFor(give);
      if (out < want) {
        state.nativeAh -= DISPATCH;
        return { ok: false, txHash, dispatchError: incomplete(2, "NoDeal") };
      }
      const debit = withdraw + DISPATCH;
      if (opts.staleDebitReads) {
        state.pendingDebit += debit;
        state.debitIn = opts.staleDebitReads;
      } else {
        state.nativeAh -= debit;
      }
      state.inFlight = out - remoteFee;
      state.arrivalIn = opts.arrivalAfterReads ?? 3;
      state.xcmLanded = true;
      return { ok: true, txHash };
    },
  });
  const api = {
    query: {
      AssetConversion: {
        Pools: { getEntries: async () => [{ keyArgs: [[NATIVE_LOC, UNDERLYING_LOC]] }] },
      },
      System: {
        Account: {
          getValue: async () => {
            if (state.debitIn > 0 && --state.debitIn === 0) {
              state.nativeAh -= state.pendingDebit;
              state.pendingDebit = 0n;
            }
            return { data: { free: state.nativeAh }, nonce: 0 };
          },
        },
      },
    },
    apis: {
      AssetConversionApi: {
        // Exact-out, both directions at the same rate.
        quote_price_tokens_for_exact_tokens: async (
          giveLoc: unknown,
          _want: unknown,
          out: bigint,
        ) => {
          state.quoteCalls += 1;
          // the quote is never needed once the transfer is in flight
          if (!opts.quoteAfterXcm && state.xcmLanded) {
            throw new Error("quote called after the XCM; should be lazy");
          }
          return giveLoc === NATIVE_LOC ? nativeFor(out) : (out * BUY) / QUOTED;
        },
        // What `nativeIn` buys, at the same rate.
        quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, nativeIn: bigint) =>
          opts.poolDepth !== undefined && nativeIn > opts.poolDepth
            ? undefined // the runtime's answer for more than the pool can price
            : underlyingFor(nativeIn),
      },
      DryRunApi: {
        dry_run_call: async (_origin: unknown, call: { value: { value: ExecuteArgs } }) =>
          dryRunCall(call.value.value),
      },
      // The landing shortfall is driven by `remoteFee`, not by these.
      XcmPaymentApi: xcmPaymentApi,
    },
    tx: {
      PolkadotXcm: { execute },
    },
  };
  const readPeople = async () => {
    if (state.arrivalIn > 0 && --state.arrivalIn === 0) {
      state.underlyingPeople += state.inFlight;
      state.inFlight = 0n;
    }
    return state.underlyingPeople;
  };
  return {
    state,
    readPeople,
    peopleApi,
    client: { getTypedApi: () => api } as unknown as PolkadotClient,
  };
}

type World = ReturnType<typeof scriptedWorld>;

type Call = { type: string; value: { type: string; value: unknown } };
type MintArgs = { external_amount: bigint; max_fee: number };
type PsmRefusal = "MintingStopped" | "AllSwapsStopped" | "ExceedsMaxPsmDebt";

/** The pallet-assets id a location in the table names. */
const generalIndex = (id: unknown) =>
  (id as { interior: { value: Array<{ value: unknown }> } }).interior.value[1]!.value;
const isCash = (a: Fungible) => generalIndex(a.id) === BigInt(TOKENS.CASH.assetHubId);
const isUsdt = (a: Fungible) => generalIndex(a.id) === BigInt(TOKENS.USDT.assetHubId);

/** Scripted Asset Hub + People for the PSM tier. The burner holds USDT and nothing else: a read of
 *  its native, of the pool's keys or an exact-in quote throws, so a tick that touches the pool
 *  tier's reads fails the test. The default destination fee is the buffer exactly, so what lands
 *  is exactly what the mint was sized for. The program's fees charge exactly the measured figures
 *  in USDT and the rest of the allowance comes back to the burner. pallet-assets is modelled where
 *  it bites: an account left below min_balance by the mint or by the withdrawal is reaped, and the
 *  program then fails to withdraw or to deposit. */
function scriptedPsmWorld(
  opts: {
    remoteFee?: bigint;
    arrivalAfterReads?: number;
    /** The PSM refuses the mint with this error, at the dry run and at inclusion alike. */
    refuse?: PsmRefusal;
    /** The dry run passes anyway, so the refusal is met at inclusion. */
    refuseAtInclusion?: boolean;
  } = {},
) {
  const remoteFee = opts.remoteFee ?? BUFFER;
  const state = {
    usdtAh: 0n,
    underlyingPeople: 0n,
    inFlight: 0n,
    arrivalIn: 0,
    /** Lifted by the tests, as an operator raising the ceiling would. */
    refuse: (opts.refuse ?? null) as PsmRefusal | null,
    /** Every chain read and dry run throws while set: a transport error, not a refusal. */
    transportDown: false,
    peopleError: undefined as string | undefined,
    txs: [] as Array<{ call: string; mint: MintArgs; args: ExecuteArgs; options: unknown }>,
  };
  const psmError = (variant: PsmRefusal) => ({
    type: "Module",
    value: { type: "Psm", value: { type: variant } },
  });
  const balanceLow = { type: "Module", value: { type: "Assets", value: { type: "BalanceLow" } } };
  const unwrap = (call: Call) => {
    if (call.type !== "Utility" || call.value.type !== "batch_all") {
      throw new Error(`expected Utility.batch_all, got ${call.type}.${call.value.type}`);
    }
    const calls = (call.value.value as { calls: Call[] }).calls;
    return { mint: calls[0]!.value.value as MintArgs, args: calls[1]!.value.value as ExecuteArgs };
  };
  const rejected = (error: unknown) => ({
    success: true,
    value: {
      execution_result: { success: false, value: { error } },
      emitted_events: [],
      forwarded_xcms: [],
    },
  });
  // The batch as the runtime runs it: the mint pays out the external minus the PSM's fee and
  // leaves the rest of the USDT on the burner; the program withdraws the minted CASH and the fee
  // allowance in USDT, moves the allowance to the fees register, teleports the CASH and deposits
  // what the fees did not spend back on the burner.
  const run = (mint: MintArgs, args: ExecuteArgs, atDryRun: boolean) => {
    if (state.refuse && !(atDryRun && opts.refuseAtInclusion)) {
      return { error: psmError(state.refuse) };
    }
    if (mint.external_amount > state.usdtAh) return { error: balanceLow };
    let usdt = state.usdtAh - mint.external_amount;
    // A mint that leaves the account below min_balance reaps it and sweeps the remainder: there is
    // no USDT left for the program to withdraw.
    if (usdt < MIN_BALANCE) return { error: incomplete(0, "FailedToTransactAsset") };
    const withdrawn = instruction(args, "WithdrawAsset") as Fungible[];
    const withdrawnCash = withdrawn.find(isCash)?.fun.value ?? 0n;
    const withdrawnUsdt = withdrawn.find(isUsdt)?.fun.value ?? 0n;
    if (withdrawnCash > psmMintOut(mint.external_amount, ROUTE.feeRate) || withdrawnUsdt > usdt) {
      return { error: incomplete(0, "FailedToTransactAsset") };
    }
    usdt -= withdrawnUsdt;
    // A withdrawal that leaves the account below min_balance reaps it too, and the refund then has
    // no live account to land in.
    if (usdt < MIN_BALANCE) return { error: incomplete(4, "FailedToTransactAsset") };
    const payFees = (instruction(args, "PayFees") as { asset: Fungible }).asset;
    if (!isUsdt(payFees) || payFees.fun.value > withdrawnUsdt) {
      return { error: incomplete(1, "NotHoldingFees") };
    }
    if (payFees.fun.value < FEES_USDT) return { error: incomplete(2, "NotHoldingFees") };
    return { teleported: withdrawnCash, usdtLeft: usdt + payFees.fun.value - FEES_USDT };
  };
  const dryRunCall = (call: Call) => {
    if (state.transportDown) throw new Error("connection dropped");
    const { mint, args } = unwrap(call);
    const outcome = run(mint, args, true);
    if ("error" in outcome) return rejected(outcome.error);
    return {
      success: true,
      value: {
        execution_result: { success: true, value: {} },
        emitted_events: [],
        forwarded_xcms: [[toPeople, [forwardedProgram(transferOf(args), outcome.teleported)]]],
      },
    };
  };
  const batchAll = ({ calls }: { calls: Call[] }) => {
    const call: Call = { type: "Utility", value: { type: "batch_all", value: { calls } } };
    const { mint, args } = unwrap(call);
    return {
      decodedCall: call,
      getEstimatedFees: async () => DISPATCH,
      signAndSubmit: async (_signer: unknown, options: unknown) => {
        state.txs.push({ call: "swap", mint, args, options });
        const txHash = `0x${state.txs.length.toString(16).padStart(64, "0")}`;
        // ChargeAssetTxPayment takes the dispatch fee in USDT before anything runs.
        state.usdtAh -= DISPATCH_USDT;
        const outcome = run(mint, args, false);
        if ("error" in outcome) return { ok: false, txHash, dispatchError: outcome.error };
        state.usdtAh = outcome.usdtLeft;
        state.inFlight = outcome.teleported - remoteFee;
        state.arrivalIn = opts.arrivalAfterReads ?? 3;
        return { ok: true, txHash };
      },
    };
  };
  const api = {
    query: {
      AssetConversion: {
        Pools: {
          getEntries: async () => {
            throw new Error("pool discovery on the psm tier");
          },
        },
      },
      System: {
        Account: {
          getValue: async () => {
            throw new Error("native read on the psm tier");
          },
        },
      },
      Assets: {
        Asset: {
          getValue: async (assetId: number) => {
            if (state.transportDown) throw new Error("connection dropped");
            expect(assetId).toBe(TOKENS.USDT.assetHubId);
            return { min_balance: MIN_BALANCE };
          },
        },
        Account: {
          getValue: async (assetId: number) => {
            if (state.transportDown) throw new Error("connection dropped");
            if (assetId !== TOKENS.USDT.assetHubId) throw new Error(`asset ${assetId} read`);
            return state.usdtAh === 0n ? undefined : { balance: state.usdtAh };
          },
        },
      },
    },
    apis: {
      AssetConversionApi: {
        // The one pool read the tier makes: the dispatch fee priced in USDT.
        quote_price_tokens_for_exact_tokens: async (give: unknown, _want: unknown, out: bigint) => {
          expect(give).toEqual(TOKENS.USDT.location);
          expect(out).toBe(DISPATCH);
          return DISPATCH_USDT;
        },
        quote_price_exact_tokens_for_tokens: async () => {
          throw new Error("exact-in quote on the psm tier");
        },
      },
      DryRunApi: { dry_run_call: async (_origin: unknown, call: Call) => dryRunCall(call) },
      // The program's own fees, priced in USDT and nothing else.
      XcmPaymentApi: {
        query_xcm_weight: xcmPaymentApi.query_xcm_weight,
        query_weight_to_asset_fee: async (_weight: unknown, asset: unknown) => {
          expect(asset).toEqual({ type: "V5", value: TOKENS.USDT.location });
          return { success: true, value: LOCAL_USDT };
        },
        query_delivery_fees: async (_dest: unknown, _message: unknown, asset: unknown) => {
          expect(asset).toEqual({ type: "V5", value: TOKENS.USDT.location });
          return {
            success: true,
            value: { value: [{ fun: { type: "Fungible", value: DELIVERY_USDT } }] },
          };
        },
      },
    },
    tx: {
      Psm: {
        mint: (args: MintArgs) => ({
          decodedCall: { type: "Psm", value: { type: "mint", value: args } },
        }),
      },
      PolkadotXcm: {
        execute: (args: ExecuteArgs) => ({
          decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } },
        }),
      },
      Utility: { batch_all: batchAll },
    },
  };
  const readPeople = async () => {
    if (state.arrivalIn > 0 && --state.arrivalIn === 0) {
      state.underlyingPeople += state.inFlight;
      state.inFlight = 0n;
    }
    return state.underlyingPeople;
  };
  return {
    state,
    readPeople,
    peopleApi: scriptedPeople({ fee: () => remoteFee, error: () => state.peopleError }),
    client: { getTypedApi: () => api } as unknown as PolkadotClient,
  };
}

type Driveable = Pick<World, "client" | "peopleApi" | "readPeople"> & {
  state: { txs: Array<{ call: string }> };
};

/** Drives `world` one tick at a time until done or `ticks` ticks. */
async function drive(
  world: Driveable,
  ticks: number,
  state: TickState = freshTickState(),
  route: ConversionRoute = POOL,
) {
  const steps: FundingStep[] = [];
  const transients: string[] = [];
  let now = 1_000;
  for (let tick = 0; tick < ticks; tick += 1) {
    now += 1_000;
    const outcome = await tickOnce(
      {
        api: (world.client as unknown as { getTypedApi: () => never }).getTypedApi(),
        peopleApi: world.peopleApi as never,
        route,
        ...(route.tier === "pool"
          ? { pool: { native: NATIVE_LOC as never, underlying: UNDERLYING_LOC as never } }
          : {}),
        address: "5Burner",
        signer: {} as never,
        beneficiaryHex: BENEFICIARY_HEX,
        settleAmount: SETTLE,
        peopleParaId: PEOPLE_PARA,
        assetHubParaId: ASSET_HUB_PARA,
        remoteFeeBuffer: BUFFER,
        keepNativeForFees: KEEP,
        slippagePct: 2,
        tickTimeoutMs: 1_000,
        submitTimeoutMs: 1_000,
        signOptions: SIGN_OPTIONS,
        readUnderlyingOnPeople: world.readPeople,
        now: () => now,
        onTransientError: (e) => transients.push(e instanceof Error ? e.message : String(e)),
      },
      state,
    );
    steps.push(outcome.step);
    if (outcome.step === "done") break;
  }
  return { steps, state, transients, txs: world.state.txs.map((t) => t.call) };
}

describe("tickOnce", () => {
  it("turns a deposit into CASH on People one tick at a time: funding program, arrival, done", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 2 });
    // Nothing has arrived: the tick waits and the clock has not started.
    const idle = await drive(world, 1);
    expect(idle.steps).toEqual(["await-native"]);
    expect(idle.state.fundsSeenAt).toBeNull();

    world.state.nativeAh = MAX_IN + KEEP;
    const run = await drive(world, 6, idle.state);
    expect(run.steps).toEqual(["swap", "await-arrival", "done"]);
    expect(run.txs).toEqual(["swap"]);
    expect(run.state).toMatchObject({ attempts: 1, xcmSubmitted: true });
    // The clock started on the first tick that saw funds, and only then.
    expect(run.state.fundsSeenAt).toBe(2_000);
    expect(world.state.underlyingPeople).toBeGreaterThanOrEqual(SETTLE);
    // Nothing native is left behind: the burner ends at zero by construction.
    expect(world.state.nativeAh).toBe(0n);
    expect(run.transients).toEqual([]);
  });

  it("builds the funding program: exact fee allowances, the whole balance converted, measured weight declared", async () => {
    const world = scriptedWorld();
    world.state.nativeAh = FUND; // a generous sender
    await drive(world, 1);
    const [tx] = world.state.txs;
    const args = tx!.args;
    // The withdrawal is the balance minus the dispatch fee the account pays up front.
    expect((instruction(args, "WithdrawAsset") as Fungible[])[0]!.fun.value).toBe(FUND - DISPATCH);
    // The fee allowance is exactly the measured local plus delivery fee.
    const payFees = instruction(args, "PayFees") as { asset: Fungible };
    expect(payFees.asset.fun.value).toBe(PAYFEES);
    // Everything the fees leave is given, not just the quote for the target, and the floor is the
    // requirement itself.
    const exchange = exchangeOf(args);
    expect(exchange.give.value[0]!.fun.value).toBe(FUND - OVERHEAD);
    expect(exchange.give.value[0]!.fun.value).toBeGreaterThan(MAX_IN);
    expect(exchange.want[0]!.fun.value).toBe(BUY);
    expect(exchange.maximal).toBe(true);
    const transfer = instruction(args, "InitiateTransfer") as {
      destination: { interior: { value: { value: number } } };
      remote_fees: { value: { value: Fungible[] } };
      preserve_origin: boolean;
      remote_xcm: Array<{ type: string; value?: unknown }>;
    };
    expect(transfer.destination.interior.value.value).toBe(1004);
    expect(transfer.remote_fees.value.value[0]!.fun.value).toBe(EARMARK);
    expect(transfer.preserve_origin).toBe(false);
    expect(transfer.remote_xcm.map((i) => i.type)).toEqual(["RefundSurplus", "DepositAsset"]);
    const deposit = transfer.remote_xcm[1]!.value as {
      beneficiary: { interior: { value: { value: { id: string } } } };
    };
    // papi encodes fixed-size binaries from their hex-string form
    expect(deposit.beneficiary.interior.value.value.id).toBe(`0x${"07".repeat(32)}`);
    // The declared ceiling is exactly the weighed weight.
    expect(args.max_weight).toEqual({ ref_time: 1_000_000n, proof_size: 1_000n });
    // Dispatched in native with the tick's anchor, no fee-asset override.
    expect(tx!.options).toEqual(SIGN_OPTIONS);
    expect(world.state.nativeAh).toBe(0n);
  });

  it("holds after its own submit while the debit is not yet visible, instead of converting again", async () => {
    const world = scriptedWorld({ staleDebitReads: 2 });
    world.state.nativeAh = MAX_IN + KEEP;
    const run = await drive(world, 3);
    // Ticks 2 and 3 still read the native as present: in flight, not "convert again".
    expect(run.steps).toEqual(["swap", "await-arrival", "await-arrival"]);
    expect(run.txs).toEqual(["swap"]);
  });

  it("falls back to buying the target when the pool cannot absorb the whole deposit", async () => {
    const world = scriptedWorld({ poolDepth: MAX_IN });
    world.state.nativeAh = FUND;
    const run = await drive(world, 1);
    expect(run.steps).toEqual(["swap"]);
    expect(exchangeOf(world.state.txs[0]!.args).give.value[0]!.fun.value).toBe(MAX_IN);
    expect(run.transients[0]).toContain("cannot absorb");
    // The surplus stays on the burner, reachable through its secret.
    expect(world.state.nativeAh).toBe(FUND - MAX_IN - OVERHEAD);
  });

  it("fails loudly on a shortfall, and a re-armed state can buy the deficit from a new deposit", async () => {
    // The destination fee rose between the dry run and the execution and eats past the buffer:
    // People lands short of the target.
    const world = scriptedWorld({
      remoteFee: BUFFER * 3n,
      remoteFeeAtDryRun: BUFFER,
      arrivalAfterReads: 1,
      quoteAfterXcm: true,
    });
    world.state.nativeAh = MAX_IN + KEEP;
    const state = freshTickState();
    await drive(world, 1, state); // the submit
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(FundingShortfallError);
    expect(world.state.underlyingPeople).toBeLessThan(SETTLE);

    // Latches released and more native sent: the deficit is bought and moved.
    Object.assign(state, freshTickState());
    world.state.nativeAh = MAX_IN + KEEP;
    const retry = await drive(world, 6, state);
    expect(retry.steps.at(-1)).toBe("done");
    expect(retry.txs).toEqual(["swap", "swap"]);
  });

  it("with the xcm latch still held, a new deposit is never converted", async () => {
    const world = scriptedWorld({
      remoteFee: BUFFER * 3n,
      remoteFeeAtDryRun: BUFFER,
      arrivalAfterReads: 1,
    });
    world.state.nativeAh = MAX_IN + KEEP;
    const state = freshTickState();
    await drive(world, 1, state);
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(FundingShortfallError);

    world.state.nativeAh = MAX_IN + KEEP;
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(FundingShortfallError);
    expect(world.state.txs.map((t) => t.call)).toEqual(["swap"]);
  });

  it("names the failed instruction on a rejection, keeps the deposit native, and retries with fresh estimates", async () => {
    // The runtime refuses the send. The program rolls back whole and the account is only the
    // dispatch fee lighter, so a deposit asked with headroom still clears the gate next tick.
    const world = scriptedWorld({ rejectSubmits: 1 });
    world.state.nativeAh = ASK + KEEP;
    const state = freshTickState();
    await expect(drive(world, 1, state)).rejects.toThrow(
      /funding program dispatch rejected: InitiateTransfer failed with FeesNotMet/,
    );
    expect(world.state.nativeAh).toBe(ASK + KEEP - DISPATCH);
    expect(state).toMatchObject({ attempts: 1, xcmSubmitted: false });

    const retry = await drive(world, 1, state);
    expect(retry.steps).toEqual(["swap"]);
    expect(state).toMatchObject({ attempts: 2, xcmSubmitted: true });
    // Nothing is padded: the retry is priced afresh from the remaining balance, and the burner
    // still ends at zero.
    const second = world.state.txs[1]!.args;
    const balance = ASK + KEEP - DISPATCH;
    expect((instruction(second, "PayFees") as { asset: Fungible }).asset.fun.value).toBe(PAYFEES);
    expect((instruction(second, "WithdrawAsset") as Fungible[])[0]!.fun.value).toBe(
      balance - DISPATCH,
    );
    expect(world.state.nativeAh).toBe(0n);
  });

  it("a program rejected at inclusion leaves the deposit native minus the dispatch fee, and retries next tick", async () => {
    // The pool moves past the floor after every quote, inside the program's own block. The floor
    // refuses the short fill and the whole program rolls back.
    const world = scriptedWorld({ priceAtSubmitBps: 10_600n });
    world.state.nativeAh = ASK + KEEP;
    const state = freshTickState();
    await expect(drive(world, 1, state)).rejects.toThrow(
      /funding program dispatch rejected: ExchangeAsset failed with NoDeal/,
    );
    expect(world.state.nativeAh).toBe(ASK + KEEP - DISPATCH);
    expect(state).toMatchObject({ attempts: 1, xcmSubmitted: false });

    // Back at the sizing price, the next tick converts.
    world.state.priceAtSubmitBps = undefined;
    world.state.priceBps = 10_000n;
    const retry = await drive(world, 1, state);
    expect(retry.steps).toEqual(["swap"]);
    expect(state.xcmSubmitted).toBe(true);
    expect(world.state.nativeAh).toBe(0n);
  });
});

describe("tickOnce on the PSM tier", () => {
  it("mints the USDT through the PSM and teleports the CASH one tick at a time: batch, arrival, done", async () => {
    const world = scriptedPsmWorld({ arrivalAfterReads: 2 });
    const idle = await drive(world, 1, freshTickState(), ROUTE);
    expect(idle.steps).toEqual(["await-native"]);
    expect(idle.state.fundsSeenAt).toBeNull();

    world.state.usdtAh = PSM_DEPOSIT;
    const run = await drive(world, 6, idle.state, ROUTE);
    expect(run.steps).toEqual(["swap", "await-arrival", "done"]);
    expect(run.txs).toEqual(["swap"]);
    expect(run.state).toMatchObject({ attempts: 1, xcmSubmitted: true, psmRefusals: 0 });
    // The destination fee took the buffer exactly, so exactly the target landed. The burner keeps
    // USDt's min_balance, which kept its account alive through the batch, plus the unspent tenth
    // of the fee allowance the program deposited back.
    expect(world.state.underlyingPeople).toBe(SETTLE);
    expect(world.state.usdtAh).toBe(MIN_BALANCE + ALLOWANCE - FEES_USDT);

    const [tx] = world.state.txs;
    // The mint takes everything the dispatch fee and the held-back USDT leave, at the route's fee
    // verbatim, and pays out exactly the target.
    expect(tx!.mint.external_amount).toBe(PSM_DEPOSIT - DISPATCH_USDT - HELD_BACK);
    expect(psmMintOut(tx!.mint.external_amount, ROUTE.feeRate)).toBe(BUY);
    expect(tx!.mint.max_fee).toBe(ROUTE.feeRate);
    // The program withdraws what the mint paid out and the fee allowance in USDT, pays the fees
    // from that allowance, exchanges nothing, and ends by refunding the surplus.
    const withdrawn = instruction(tx!.args, "WithdrawAsset") as Fungible[];
    expect(withdrawn.find(isCash)!.fun.value).toBe(BUY);
    expect(withdrawn.find(isUsdt)!.fun.value).toBe(ALLOWANCE);
    const payFees = (instruction(tx!.args, "PayFees") as { asset: Fungible }).asset;
    expect(isUsdt(payFees)).toBe(true);
    expect(payFees.fun.value).toBe(ALLOWANCE);
    expect(instruction(tx!.args, "ExchangeAsset")).toBeUndefined();
    expect(tx!.args.message.value.slice(-2).map((i) => i.type)).toEqual([
      "RefundSurplus",
      "DepositAsset",
    ]);
    expect(transferOf(tx!.args).remote_fees.value.value[0]!.fun.value).toBe(EARMARK);
    expect(tx!.args.max_weight).toEqual({ ref_time: 1_000_000n, proof_size: 1_000n });
    // The dispatch fee is charged in USDT, with the tick's anchor.
    expect(tx!.options).toEqual({ asset: TOKENS.USDT.location, ...SIGN_OPTIONS });
  });

  it("sizes the deposit for the mint PLUS the dispatch fee, the fee allowance and min_balance: one short waits", async () => {
    // Without the held-back USDT the mint would reap the burner's account and the program would
    // fail at its first instruction on every tick; without min_balance in it the withdrawal would.
    const world = scriptedPsmWorld();
    world.state.usdtAh = sizePsmMint(BUY, ROUTE).externalIn + DISPATCH_USDT;
    expect((await drive(world, 1, freshTickState(), ROUTE)).steps).toEqual(["await-native"]);
    world.state.usdtAh = sizePsmMint(BUY, ROUTE).externalIn + DISPATCH_USDT + ALLOWANCE;
    expect((await drive(world, 1, freshTickState(), ROUTE)).steps).toEqual(["await-native"]);
    world.state.usdtAh = PSM_DEPOSIT - 1n;
    expect((await drive(world, 1, freshTickState(), ROUTE)).steps).toEqual(["await-native"]);
    expect(world.state.txs).toEqual([]);
    world.state.usdtAh = PSM_DEPOSIT;
    expect((await drive(world, 1, freshTickState(), ROUTE)).steps).toEqual(["swap"]);
  });

  it("converts everything the burner holds; the surplus lands as extra CASH", async () => {
    const world = scriptedPsmWorld({ arrivalAfterReads: 1 });
    world.state.usdtAh = PSM_DEPOSIT + 1_000_000n;
    const run = await drive(world, 4, freshTickState(), ROUTE);
    expect(run.steps).toEqual(["swap", "done"]);
    expect(world.state.txs[0]!.mint.external_amount).toBe(
      PSM_DEPOSIT + 1_000_000n - DISPATCH_USDT - HELD_BACK,
    );
    expect(world.state.usdtAh).toBe(MIN_BALANCE + ALLOWANCE - FEES_USDT);
    expect(world.state.underlyingPeople).toBeGreaterThan(SETTLE);
    expect(run.transients).toEqual([]);
  });

  it("retries a mint the PSM refuses at the dry run, and holds on the third refusal with nothing spent", async () => {
    const world = scriptedPsmWorld({ refuse: "ExceedsMaxPsmDebt" });
    world.state.usdtAh = PSM_DEPOSIT;
    const state = freshTickState();
    for (let refusals = 1; refusals < MAX_PSM_REFUSALS; refusals += 1) {
      await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(
        /not submitted: Asset Hub rejects the program: Psm.ExceedsMaxPsmDebt/,
      );
      expect(state.psmRefusals).toBe(refusals);
    }
    await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(
      /funding held: the PSM refused the mint 3 times, last: Psm.ExceedsMaxPsmDebt/,
    );
    await expect(drive(world, 1, state, ROUTE)).rejects.toBeInstanceOf(FundingHeldError);
    // Nothing went out and the deposit stays on the burner, in USDT.
    expect(state).toMatchObject({ attempts: 0, xcmSubmitted: false });
    expect(world.state.txs).toEqual([]);
    expect(world.state.usdtAh).toBe(PSM_DEPOSIT);
  });

  it("counts the PSM's refusals only: a dropped connection or another rejection burns no retry", async () => {
    const world = scriptedPsmWorld({ refuse: "MintingStopped" });
    world.state.usdtAh = PSM_DEPOSIT;
    const state = freshTickState();
    await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(/Psm.MintingStopped/);
    expect(state.psmRefusals).toBe(1);
    // The connection drops: a transport error, retried without limit.
    world.state.transportDown = true;
    await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(/connection dropped/);
    world.state.transportDown = false;
    expect(state.psmRefusals).toBe(1);
    // People fails the forwarded program: a rejection, but not the PSM's.
    world.state.refuse = null;
    world.state.peopleError = "TooExpensive";
    await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(
      /not submitted: the forwarded program fails on People with TooExpensive/,
    );
    expect(state.psmRefusals).toBe(1);
    world.state.peopleError = undefined;
    // Two more refusals of the PSM's own reach the hold.
    world.state.refuse = "AllSwapsStopped";
    await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(/Psm.AllSwapsStopped/);
    expect(state.psmRefusals).toBe(2);
    await expect(drive(world, 1, state, ROUTE)).rejects.toBeInstanceOf(FundingHeldError);
    expect(world.state.txs).toEqual([]);
  });

  it("a refusal at inclusion costs the dispatch fee in USDT and counts; the run goes on once the PSM takes the mint", async () => {
    const world = scriptedPsmWorld({
      refuse: "MintingStopped",
      refuseAtInclusion: true,
      arrivalAfterReads: 1,
    });
    world.state.usdtAh = PSM_DEPOSIT;
    const state = freshTickState();
    await expect(drive(world, 1, state, ROUTE)).rejects.toThrow(
      /psm batch dispatch rejected: Psm.MintingStopped/,
    );
    expect(state).toMatchObject({ attempts: 1, psmRefusals: 1, xcmSubmitted: false });
    // The batch rolled back whole: the deposit is still USDT, the dispatch fee lighter.
    expect(world.state.usdtAh).toBe(PSM_DEPOSIT - DISPATCH_USDT);

    // The PSM reopens and the fee is made up: the next tick mints, priced afresh.
    world.state.refuse = null;
    world.state.usdtAh += DISPATCH_USDT;
    const retry = await drive(world, 4, state, ROUTE);
    expect(retry.steps).toEqual(["swap", "done"]);
    expect(state).toMatchObject({ attempts: 2, psmRefusals: 1, xcmSubmitted: true });
    expect(world.state.underlyingPeople).toBe(SETTLE);
    expect(world.state.usdtAh).toBe(MIN_BALANCE + ALLOWANCE - FEES_USDT);
  });
});

describe("psmDepositNeeded", () => {
  it("is the mint for exactly the target, plus the dispatch fee and the held-back external", () => {
    const fees = {
      localExternal: 4_000n,
      deliveryExternal: 250n,
      feeAllowanceExternal: 4_675n,
      minBalanceExternal: MIN_BALANCE,
      heldBackExternal: MIN_BALANCE + 4_675n,
      dispatchNative: DISPATCH,
      dispatchExternal: DISPATCH_USDT,
      maxWeight: { ref_time: 1n, proof_size: 1n },
    };
    const needed = psmDepositNeeded(BUY, ROUTE, fees);
    expect(needed).toBe(sizePsmMint(BUY, ROUTE).externalIn + DISPATCH_USDT + MIN_BALANCE + 4_675n);
    // The XCM's fees are not part of the mint: it pays out the target and nothing more.
    expect(psmMintOut(needed - DISPATCH_USDT - fees.heldBackExternal, ROUTE.feeRate)).toBe(BUY);
  });
});

describe("the dry run before the submit", () => {
  /** Drives one tick and expects it to stop before the submit with `reason`, nothing spent. */
  async function refuses(world: World, reason: RegExp, balance = ASK + KEEP) {
    world.state.nativeAh = balance;
    const state = freshTickState();
    await expect(drive(world, 1, state)).rejects.toThrow(reason);
    expect(world.state.txs).toEqual([]);
    expect(world.state.nativeAh).toBe(balance); // no dispatch fee paid
    expect(state).toMatchObject({ attempts: 0, xcmSubmitted: false });
  }

  it("does not submit a program Asset Hub would reject, and names the failing instruction", async () => {
    await refuses(
      scriptedWorld({ assetHubDryRunError: "FeesNotMet" }),
      /not submitted: Asset Hub rejects the program: InitiateTransfer failed with FeesNotMet/,
    );
  });

  it("does not submit a program People would fail", async () => {
    await refuses(
      scriptedWorld({ peopleDryRunError: "TooExpensive" }),
      /not submitted: the forwarded program fails on People with TooExpensive/,
    );
  });

  it("does not submit when the destination fee would eat past the target", async () => {
    // The deposit carries 2% headroom and the dry run shows People taking three times the buffer:
    // what would land is short of the settle amount, so nothing goes out and no shortfall is ever
    // created.
    await refuses(
      scriptedWorld({ remoteFee: BUFFER * 3n }),
      /not submitted: only \d+ of 5000000 underlying would reach the beneficiary on People/,
      MAX_IN + KEEP,
    );
  });

  it("does not submit a program that would trap assets on either chain", async () => {
    await refuses(
      scriptedWorld({ trapOnAssetHub: 7n }),
      /not submitted: the program would trap 7 on Asset Hub/,
    );
    await refuses(
      scriptedWorld({ trapOnPeople: 9n }),
      /not submitted: the program would trap 9 on People/,
    );
  });

  it("runs the final program as the burner and hands People what Asset Hub forwards", async () => {
    const world = scriptedWorld();
    world.state.nativeAh = ASK + KEEP;
    const seen: { origin?: unknown; call?: unknown; peopleOrigin?: unknown; program?: unknown } =
      {};
    const api = (world.client as unknown as { getTypedApi: () => never }).getTypedApi() as {
      apis: { DryRunApi: { dry_run_call: (...a: never[]) => Promise<unknown> } };
    };
    const dryRun = api.apis.DryRunApi.dry_run_call;
    api.apis.DryRunApi.dry_run_call = async (...args: never[]) => {
      // The fee estimate probes first; the last dry run before the submit is the final program.
      seen.origin = args[0];
      seen.call = args[1];
      return dryRun(...args);
    };
    const peopleDryRun = world.peopleApi.apis.DryRunApi.dry_run_xcm;
    world.peopleApi.apis.DryRunApi.dry_run_xcm = async (origin, program) => {
      seen.peopleOrigin = origin;
      seen.program = program;
      return peopleDryRun(origin, program);
    };
    const run = await drive(world, 1);
    expect(run.steps).toEqual(["swap"]);
    expect(seen.origin).toEqual({ type: "system", value: { type: "Signed", value: "5Burner" } });
    // The dry-run call is the submitted call.
    expect((seen.call as { value: { value: unknown } }).value.value).toBe(world.state.txs[0]!.args);
    expect(seen.peopleOrigin).toEqual({
      type: "V5",
      value: {
        parents: 1,
        interior: { type: "X1", value: { type: "Parachain", value: ASSET_HUB_PARA } },
      },
    });
    expect((seen.program as { value: Instruction[] }).value[0]!.type).toBe(
      "ReceiveTeleportedAsset",
    );
  });
});

describe("quoteNativeInMax", () => {
  it("adds the headroom to the plain quote, and surfaces insufficient liquidity", async () => {
    const world = scriptedWorld();
    const api = (world.client as unknown as { getTypedApi: () => never }).getTypedApi();
    const pool = { native: NATIVE_LOC as never, underlying: UNDERLYING_LOC as never };
    expect(await quoteNativeIn(api, pool, BUY)).toBe(QUOTED);
    expect(await quoteNativeInMax(api, pool, BUY, 2)).toBe(MAX_IN);

    const dry = {
      apis: {
        AssetConversionApi: { quote_price_tokens_for_exact_tokens: async () => undefined },
      },
    } as never;
    await expect(quoteNativeInMax(dry, pool, BUY, 2)).rejects.toThrow(/insufficient liquidity/);
  });
});

describe("discoverPool", () => {
  const apiWith = (entries: unknown[]) =>
    ({ query: { AssetConversion: { Pools: { getEntries: async () => entries } } } }) as never;

  it("finds the pool from either key order", async () => {
    const flipped = await discoverPool(
      apiWith([{ keyArgs: [[UNDERLYING_LOC, NATIVE_LOC]] }]),
      50_000_413,
    );
    expect(flipped).toEqual({ native: NATIVE_LOC, underlying: UNDERLYING_LOC });
  });

  it("throws when no pool exists or none pairs the underlying with the native", async () => {
    await expect(discoverPool(apiWith([]), 50_000_413)).rejects.toThrow(
      /no native AssetConversion pool/,
    );
    // an underlying/underlying pool (counter-side not interior-Here) must not match
    await expect(
      discoverPool(apiWith([{ keyArgs: [[UNDERLYING_LOC, UNDERLYING_LOC]] }]), 50_000_413),
    ).rejects.toThrow(/no native AssetConversion pool/);
    // a pool for a different GeneralIndex must not match
    await expect(
      discoverPool(
        apiWith([
          {
            keyArgs: [
              [
                NATIVE_LOC,
                {
                  parents: 0,
                  interior: {
                    type: "X2",
                    value: [
                      { type: "PalletInstance", value: 50 },
                      { type: "GeneralIndex", value: 999n },
                    ],
                  },
                },
              ],
            ],
          },
        ]),
        50_000_413,
      ),
    ).rejects.toThrow(/no native AssetConversion pool/);
  });

  it("matches GeneralIndex regardless of number/bigint decoding", async () => {
    const numericLoc = {
      parents: 0,
      interior: {
        type: "X2",
        value: [
          { type: "PalletInstance", value: 50 },
          { type: "GeneralIndex", value: 50_000_413 }, // number, not bigint
        ],
      },
    };
    const found = await discoverPool(
      apiWith([{ keyArgs: [[NATIVE_LOC, numericLoc]] }]),
      50_000_413,
    );
    expect(found.underlying).toBe(numericLoc);
  });
});

describe("sizeNativeBudget", () => {
  it("asks for the quote for settle+buffer plus the default headroom, plus fee native", async () => {
    const world = scriptedWorld();
    const budget = await sizeNativeBudget({
      client: world.client,
      underlyingAssetId: 50_000_413,
      settleAmount: SETTLE,
      remoteFeeBuffer: BUFFER,
      keepNativeForFees: KEEP,
    });
    expect(budget).toBe(ASK + KEEP);
    expect(ASK).toBe((QUOTED * 10_500n) / 10_000n); // 5%: shallow liquidity on Paseo
  });

  it("quotes the same ask whatever the burner already holds", async () => {
    // No credit is netted; the quote is the full ask.
    const world = scriptedWorld();
    world.state.nativeAh = FUND;
    world.state.underlyingPeople = BUY;
    expect(
      await sizeNativeBudget({
        client: world.client,
        underlyingAssetId: 50_000_413,
        settleAmount: SETTLE,
        remoteFeeBuffer: BUFFER,
        keepNativeForFees: KEEP,
      }),
    ).toBe(ASK + KEEP);
  });
});

describe("the headroom survives a price move", () => {
  // The incident: a deposit sized to the exact gate was stranded by any upward move, because
  // the gate re-applied the headroom the ask already carried. Now the ask carries it once and
  // the gate checks the plain quote, so the deposit clears as long as the move stays inside it.
  async function deposit(world: World) {
    const budget = await sizeNativeBudget({
      client: world.client,
      underlyingAssetId: 50_000_413,
      settleAmount: SETTLE,
      remoteFeeBuffer: BUFFER,
      keepNativeForFees: KEEP,
    });
    world.state.nativeAh = budget; // exactly what was asked, as the faucet and rails deliver
  }

  it("converts a deposit sized before the pool moved 3% against it, and still lands the target", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 1 });
    await deposit(world);
    world.state.priceBps = 10_300n;
    const run = await drive(world, 4);
    expect(run.steps).toEqual(["swap", "done"]);
    // The floor is the requirement itself, not a slice of the expected fill.
    expect(exchangeOf(world.state.txs[0]!.args).want[0]!.fun.value).toBe(BUY);
    // At least the target reached People; the unused headroom became extra CASH.
    expect(world.state.underlyingPeople).toBeGreaterThanOrEqual(SETTLE);
  });

  it("still waits when the pool moved past the headroom: the deposit no longer buys the target", async () => {
    const world = scriptedWorld();
    await deposit(world);
    world.state.priceBps = 10_600n;
    const run = await drive(world, 1);
    expect(run.steps).toEqual(["await-native"]);
    expect(world.state.txs).toEqual([]);
  });

  it("waits without submitting when the pool moves past the floor between the gate and the submit", async () => {
    // The pool moves past the headroom right after the gate was judged. The spend quote comes back
    // under the floor, so the tick throws before submitting and no dispatch fee is spent. The next
    // tick re-reads the price and converts once it is back.
    const world = scriptedWorld();
    await deposit(world);
    const state = freshTickState();
    const api = (world.client as unknown as { getTypedApi: () => never }).getTypedApi() as {
      apis: {
        AssetConversionApi: {
          quote_price_tokens_for_exact_tokens: (...a: never[]) => Promise<bigint>;
        };
      };
    };
    const quoteAtFlatPrice = api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens;
    api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens = async (...args: never[]) => {
      const quoted = await quoteAtFlatPrice(...args);
      world.state.priceBps = 10_600n; // moves past the headroom right after the gate was judged
      return quoted;
    };
    await expect(drive(world, 1, state)).rejects.toThrow(/below the target/);
    expect(world.state.txs).toEqual([]);
    expect(world.state.nativeAh).toBe(ASK + KEEP); // nothing spent
    expect(state).toMatchObject({ attempts: 0, xcmSubmitted: false });

    api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens = quoteAtFlatPrice;
    world.state.priceBps = 10_000n;
    const retry = await drive(world, 1, state);
    expect(retry.steps).toEqual(["swap"]);
    expect(state.xcmSubmitted).toBe(true);
  });
});

describe("estimateDestinationFeeCash", () => {
  const pool = { native: NATIVE_LOC as never, underlying: UNDERLYING_LOC as never };
  // The underlying as People keys it: the pool's local X2 behind Asset Hub's parachain junction.
  const onPeople = {
    parents: 1,
    interior: {
      type: "X3",
      value: [{ type: "Parachain", value: 1500 }, ...UNDERLYING_LOC.interior.value],
    },
  };
  const deposited = (who: string, amount: bigint) => ({
    type: "Assets",
    value: { type: "Deposited", value: { asset_id: onPeople, who, amount } },
  });
  const peopleApiDryRunning = (calls: { origin?: unknown; program?: unknown }, events: unknown[]) =>
    ({
      apis: {
        DryRunApi: {
          dry_run_xcm: async (origin: unknown, program: unknown) => {
            calls.origin = origin;
            calls.program = program;
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
    }) as never;

  it("dry-runs the forwarded program on People as Asset Hub and reads the fee the beneficiary loses, a tenth on top", async () => {
    const calls: { origin?: unknown; program?: unknown } = {};
    // Two teleports of BUY reach People; 43 goes to the fee receiver, the rest to the beneficiary.
    // 43 is what People charges today at every amount; the estimate carries 48.
    const events = [
      deposited(AccountId(42).dec(BENEFICIARY), 2n * BUY - 43n),
      deposited(AccountId(42).dec(new Uint8Array(32).fill(9)), 43n),
    ];
    const fee = await estimateDestinationFeeCash({
      peopleApi: peopleApiDryRunning(calls, events),
      pool,
      assetHubParaId: 1500,
      beneficiaryHex: BENEFICIARY_HEX,
      amount: BUY,
    });
    expect(fee).toBe(48n);
    expect(calls.origin).toEqual({
      type: "V5",
      value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: 1500 } } },
    });
    const program = calls.program as { value: Array<{ type: string; value?: unknown }> };
    expect(program.value.map((i) => i.type)).toEqual([
      "ReceiveTeleportedAsset",
      "PayFees",
      "ReceiveTeleportedAsset",
      "ClearOrigin",
      "RefundSurplus",
      "DepositAsset",
      "SetTopic",
    ]);
    expect((program.value[0]!.value as Array<{ id: unknown }>)[0]!.id).toEqual(onPeople);
  });

  it("keeps an underlying already keyed from the relay as it is", async () => {
    const calls: { origin?: unknown; program?: unknown } = {};
    const relayKeyed = {
      parents: 1,
      interior: { type: "X1", value: { type: "Parachain", value: 2000 } },
    };
    await estimateDestinationFeeCash({
      peopleApi: peopleApiDryRunning(calls, [deposited(AccountId(42).dec(BENEFICIARY), 2n * BUY)]),
      pool: { native: NATIVE_LOC as never, underlying: relayKeyed as never },
      assetHubParaId: 1500,
      beneficiaryHex: BENEFICIARY_HEX,
      amount: BUY,
    });
    const program = calls.program as { value: Array<{ type: string; value?: unknown }> };
    expect((program.value[0]!.value as Array<{ id: unknown }>)[0]!.id).toEqual(relayKeyed);
  });

  it("throws when the program does not complete on People or nothing reaches the beneficiary", async () => {
    const failing = {
      apis: {
        DryRunApi: {
          dry_run_xcm: async () => ({
            success: true,
            value: {
              execution_result: {
                type: "Incomplete",
                value: { used: {}, error: { type: "TooExpensive" } },
              },
              emitted_events: [],
            },
          }),
        },
      },
    } as never;
    const common = { pool, assetHubParaId: 1500, beneficiaryHex: BENEFICIARY_HEX, amount: BUY };
    await expect(estimateDestinationFeeCash({ peopleApi: failing, ...common })).rejects.toThrow(
      /fails on People with TooExpensive/,
    );
    const strangerOnly = peopleApiDryRunning({}, [
      deposited(AccountId(42).dec(new Uint8Array(32).fill(9)), 43n),
    ]);
    await expect(
      estimateDestinationFeeCash({ peopleApi: strangerOnly, ...common }),
    ).rejects.toThrow(/nothing reached the beneficiary/);
  });
});

describe("destinationEarmark", () => {
  it("is the sized over-buy, or 1% of the target when that is more, and never zero", () => {
    expect(destinationEarmark(BUY, BUFFER)).toBe(BUFFER); // 1% of 5.1 is 0.051 < 0.1
    expect(destinationEarmark(50_000_000n, BUFFER)).toBe(500_000n); // 1% of 50 is 0.5 > 0.1
    expect(destinationEarmark(0n, 0n)).toBe(1n);
  });
});

describe("describeDispatchError", () => {
  const execArgs = {
    message: {
      value: [
        { type: "WithdrawAsset" },
        { type: "PayFees" },
        { type: "ExchangeAsset" },
        { type: "InitiateTransfer" },
      ],
    },
  };
  const incomplete = (index: number, error: string) => ({
    type: "Module",
    value: {
      type: "PolkadotXcm",
      value: {
        type: "LocalExecutionIncompleteWithError",
        value: { index, error: { type: error } },
      },
    },
  });

  it("names the instruction an incomplete execution stopped at", () => {
    expect(describeDispatchError(incomplete(2, "NoDeal"), execArgs)).toBe(
      "ExchangeAsset failed with NoDeal",
    );
    expect(describeDispatchError(incomplete(0, "FailedToTransactAsset"), execArgs)).toBe(
      "WithdrawAsset failed with FailedToTransactAsset",
    );
    // an index the submitted message does not have, or no message to look it up in
    expect(describeDispatchError(incomplete(9, "Barrier"), execArgs)).toBe(
      "instruction #9 failed with Barrier",
    );
    expect(describeDispatchError(incomplete(1, "TooExpensive"))).toBe(
      "instruction #1 failed with TooExpensive",
    );
  });

  it("falls back to the pallet and variant, the bare kind, or a placeholder", () => {
    expect(
      describeDispatchError({
        type: "Module",
        value: { type: "PolkadotXcm", value: { type: "Filtered" } },
      }),
    ).toBe("PolkadotXcm.Filtered");
    expect(describeDispatchError({ type: "BadOrigin" })).toBe("BadOrigin");
    expect(describeDispatchError(undefined)).toBe("dispatch error unavailable");
    expect(describeDispatchError({ value: 3 })).toBe("unrecognised dispatch error");
  });
});

describe("createManualRail", () => {
  it("quotes identity (with decimal ceil-normalization) and hands out the ephemeral itself", async () => {
    const rail = createManualRail({ now: () => 1_000, depositExpiryMs: 500 });
    const quote = await rail.getQuote({
      sourceId: "dot-assethub",
      target: { amount: 5_000_000n, decimals: 6 }, // 5 whole at 6-dec -> 5e10 at 10-dec
    });
    expect(quote.source.amount).toBe(50_000_000_000n);
    expect(quote.source.formatted).toBe("5");

    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: "5EphemeralOnAssetHub",
      refundAddress: "unused",
    });
    expect(channel.deposit.address).toBe("5EphemeralOnAssetHub");
    expect(channel.deposit.expiresAt).toBe(1_500);
    expect((await rail.getStatus("manual")).status).toBe("waiting");
    expect((await rail.probeLiquidity("dot-assethub")).status).toBe("available");
    expect(rail.sources()[0]?.sourceId).toBe("dot-assethub");
  });

  it("built for a stable, quotes and names the deposit in it", async () => {
    const rail = createManualRail({ token: TOKENS.USDT });
    const quote = await rail.getQuote({
      sourceId: "dot-assethub",
      target: { amount: 5_000_000n, decimals: 6 },
    });
    expect(quote.source).toEqual({
      amount: 5_000_000n,
      formatted: "5",
      assetSymbol: "USDT",
      decimals: 6,
    });
    expect(rail.sources()[0]?.asset).toBe("USDT");
  });
});
