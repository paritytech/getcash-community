// Offline coverage over a scripted chain: the step decision, single ticks of the funding program,
// pool discovery, the quote headroom, the deposit sizing, the dispatch-error decoder, and the
// manual rail.

import type { PolkadotClient } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { describeDispatchError } from "./dispatch-error";
import { createManualRail } from "./manual-rail";
import { destinationEarmark } from "./funding-program";
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
  // The program as the runtime runs it. The dispatch fee is charged whatever happens. On success
  // the withdrawn native leaves in full, the exchange fills at the pool rate and the result goes in
  // flight to People minus the destination fee. A rejection rolls the program back and only the
  // dispatch fee is gone. Nothing ever credits an AH underlying account.
  const execute = (args: ExecuteArgs) => ({
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
      // The funding program's fee reads, scripted small; the landing shortfall is driven by
      // `remoteFee`. No DryRunApi: the estimator prices delivery from the stand-in program.
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
  return { state, readPeople, client: { getTypedApi: () => api } as unknown as PolkadotClient };
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
        pool: { native: NATIVE_LOC as never, underlying: UNDERLYING_LOC as never },
        address: "5Burner",
        signer: {} as never,
        beneficiaryHex: `0x${"07".repeat(32)}`,
        settleAmount: SETTLE,
        peopleParaId: 1004,
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
    // The destination fee eats past the buffer: People lands short of the target.
    const world = scriptedWorld({
      remoteFee: BUFFER * 3n,
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
    const world = scriptedWorld({ remoteFee: BUFFER * 3n, arrivalAfterReads: 1 });
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
