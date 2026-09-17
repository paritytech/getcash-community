// Offline coverage over a scripted chain: the step decision, single ticks of the funding program,
// pool discovery, the quote headroom, the deposit sizing, the dispatch-error decoder, and the
// manual rail.

import { AccountId, type PolkadotClient } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { describeDispatchError } from "./dispatch-error";
import { createManualRail } from "./manual-rail";
import { destinationEarmark, estimateDestinationFeeCash } from "./funding-program";
import {
  decideStep,
  DEFAULT_SLIPPAGE_PCT,
  discoverPool,
  freshTickState,
  FundingShortfallError,
  quoteNativeIn,
  quoteNativeInMax,
  sizeNativeBudget,
  tickOnce,
  type FundingStep,
  type TickState,
} from "./pipeline";

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
const PAYFEES = LOCAL_FEE + DELIVERY; // the earmark is exact
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
  const targets = {
    settleAmount: SETTLE,
    remoteFeeBuffer: BUFFER,
    keepNativeForFees: KEEP,
    nativeNeeded: QUOTED,
  };
  it("done once the underlying reached People, and not one base unit sooner", () => {
    expect(decideStep({ nativeAh: 0n, underlyingPeople: SETTLE }, targets)).toBe("done");
    // the partial-arrival world: the destination fee ate past the buffer
    expect(decideStep({ nativeAh: 0n, underlyingPeople: SETTLE - 1n }, targets)).toBe(
      "await-native",
    );
  });
  it("converts once native covers the plain quote plus the fee native, no headroom demanded", () => {
    expect(decideStep({ nativeAh: QUOTED + KEEP, underlyingPeople: 0n }, targets)).toBe("swap");
    expect(decideStep({ nativeAh: QUOTED + KEEP - 1n, underlyingPeople: 0n }, targets)).toBe(
      "await-native",
    );
  });
});

type Instruction = { type: string; value: never };
type Fungible = { fun: { value: bigint } };
type ExecuteArgs = { message: { value: Instruction[] }; max_weight: unknown };

const instruction = (args: ExecuteArgs, type: string) =>
  args.message.value.find((i) => i.type === type)?.value as never;
const exchangeOf = (args: ExecuteArgs) =>
  instruction(args, "ExchangeAsset") as {
    give: { value: Fungible[] };
    want: Fungible[];
    maximal: boolean;
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
    const transfer = instruction(args, "InitiateTransfer") as {
      remote_fees: { value: { value: Fungible[] } };
      remote_xcm: Instruction[];
    };
    const earmark = transfer.remote_fees.value.value[0]!.fun.value;
    // What the runtime forwards: the fee teleport, the asset teleport, then the remote program.
    const forwarded = {
      type: "V5",
      value: [
        { type: "ReceiveTeleportedAsset", value: [fungible(earmark)] },
        { type: "PayFees", value: { asset: fungible(earmark) } },
        { type: "ReceiveTeleportedAsset", value: [fungible(out - earmark)] },
        { type: "ClearOrigin" },
        ...transfer.remote_xcm,
        { type: "SetTopic", value: `0x${"00".repeat(32)}` },
      ],
    };
    const toPeople = {
      type: "V5",
      value: {
        parents: 1,
        interior: { type: "X1", value: { type: "Parachain", value: PEOPLE_PARA } },
      },
    };
    return {
      success: true,
      value: {
        execution_result: { success: true, value: {} },
        emitted_events: trapped(opts.trapOnAssetHub),
        forwarded_xcms: [[toPeople, [forwarded]]],
      },
    };
  };
  // People's side of the dry run: the teleported amounts minus the fee reach the beneficiary.
  const peopleApi = {
    apis: {
      DryRunApi: {
        dry_run_xcm: async (_origin: unknown, program: { value: Instruction[] }) => {
          if (opts.peopleDryRunError) {
            return {
              success: true,
              value: {
                execution_result: {
                  type: "Incomplete",
                  value: { used: {}, error: { type: opts.peopleDryRunError } },
                },
                emitted_events: [],
              },
            };
          }
          const teleported = program.value
            .filter((i) => i.type === "ReceiveTeleportedAsset")
            .reduce((sum, i) => sum + (i.value as Fungible[])[0]!.fun.value, 0n);
          const fee = opts.remoteFeeAtDryRun ?? remoteFee;
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
                ...trapped(opts.trapOnPeople),
              ],
            },
          };
        },
      },
    },
  };
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
      // The funding program's fee reads, scripted small; the landing shortfall is driven by
      // `remoteFee`.
      XcmPaymentApi: {
        query_xcm_weight: async () => ({
          success: true,
          value: { ref_time: 1_000_000n, proof_size: 1_000n },
        }),
        query_weight_to_asset_fee: async () => ({ success: true, value: LOCAL_FEE }),
        query_delivery_fees: async () => ({
          success: true,
          value: { value: [{ fun: { type: "Fungible", value: DELIVERY } }] },
        }),
      },
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

/** Drives `world` one tick at a time until done or `ticks` ticks. */
async function drive(world: World, ticks: number, state: TickState = freshTickState()) {
  const steps: FundingStep[] = [];
  const transients: string[] = [];
  let now = 1_000;
  for (let tick = 0; tick < ticks; tick += 1) {
    now += 1_000;
    const outcome = await tickOnce(
      {
        api: (world.client as unknown as { getTypedApi: () => never }).getTypedApi(),
        peopleApi: world.peopleApi as never,
        pool: { native: NATIVE_LOC as never, underlying: UNDERLYING_LOC as never },
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

  it("dry-runs the forwarded program on People as Asset Hub and reads the fee the beneficiary loses", async () => {
    const calls: { origin?: unknown; program?: unknown } = {};
    // Two teleports of BUY reach People; 43 goes to the fee receiver, the rest to the beneficiary.
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
    expect(fee).toBe(43n);
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
});
