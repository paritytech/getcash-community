// Offline coverage over a scripted chain: the step decision, single ticks, pool discovery,
// the quote slippage cap, the deposit sizing, and the manual rail.

import type { PolkadotClient } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { createManualRail } from "./manual-rail";
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
const KEEP = 1_000_000_000n;
const QUOTED = 1_281_000_000n; // native the pool quotes for BUY
const MAX_IN = (QUOTED * 10_200n) / 10_000n; // +2%, the headroom `drive` passes
/** What the page asks for at the default headroom: the quote plus DEFAULT_SLIPPAGE_PCT. */
const ASK = (QUOTED * BigInt(10_000 + DEFAULT_SLIPPAGE_PCT * 100)) / 10_000n;
/** An over-funded burner: post-swap native (MAX_IN + KEEP) would re-satisfy the swap gate. */
const FUND = QUOTED + MAX_IN + KEEP;

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
    expect(decideStep({ nativeAh: 0n, underlyingAh: 0n, underlyingPeople: SETTLE }, targets)).toBe(
      "done",
    );
    // the partial-arrival world: remote fee ate past the buffer
    expect(
      decideStep({ nativeAh: 0n, underlyingAh: 0n, underlyingPeople: SETTLE - 1n }, targets),
    ).toBe("await-native");
  });
  it("xcm whenever bought underlying sits on AH, even if native could buy again", () => {
    expect(decideStep({ nativeAh: 0n, underlyingAh: BUY, underlyingPeople: 0n }, targets)).toBe(
      "xcm",
    );
    expect(decideStep({ nativeAh: FUND, underlyingAh: BUY, underlyingPeople: 0n }, targets)).toBe(
      "xcm",
    );
  });
  it("swap once native covers the plain quote plus the fee reserve, no headroom demanded", () => {
    expect(
      decideStep({ nativeAh: QUOTED + KEEP, underlyingAh: 0n, underlyingPeople: 0n }, targets),
    ).toBe("swap");
    expect(
      decideStep({ nativeAh: QUOTED + KEEP - 1n, underlyingAh: 0n, underlyingPeople: 0n }, targets),
    ).toBe("await-native");
  });
});

/** Scripted Asset Hub + People. XCM arrival is counted in People reads, not wall-clock. */
function scriptedWorld(
  opts: {
    remoteFee?: bigint;
    arrivalAfterReads?: number;
    /** Delay the swap's underlying credit by N AH asset reads (a stale-read window). */
    swapCreditAfterReads?: number;
    /** The most native the pool can price in one swap; above it the exact-in quote answers
     *  `undefined`. */
    poolDepth?: bigint;
    /** Allow quotes after the XCM; a second run over the same burner quotes again. */
    quoteAfterXcm?: boolean;
  } = {},
) {
  const remoteFee = opts.remoteFee ?? 50_000n;
  const state = {
    /** The pool's native price for the underlying, in basis points of the sizing-time rate:
     *  10_000 is the rate the deposit was sized at, 10_300 is 3% dearer. */
    priceBps: 10_000n,
    nativeAh: 0n,
    underlyingAh: 0n,
    underlyingPeople: 0n,
    inFlight: 0n,
    arrivalIn: 0, // People reads remaining until the in-flight amount credits
    pendingSwapCredit: 0n,
    swapCreditIn: 0, // AH asset reads remaining until the swap credit becomes visible
    quoteCalls: 0,
    quoteFailuresLeft: 0,
    txs: [] as Array<{ call: string; args: unknown }>,
  };
  // An effect may return false: the dispatch reverted (the runtime's answer when the pool
  // cannot fill `amount_out_min`), leaving balances untouched.
  const tx = (call: string, effect: (args: never) => boolean | void) => (args: never) => ({
    signAndSubmit: async () => {
      state.txs.push({ call, args });
      const ok = effect(args) !== false;
      return { ok, txHash: `0x${state.txs.length.toString(16).padStart(64, "0")}` };
    },
  });
  /** Native for `out` underlying at the current price. */
  const nativeFor = (out: bigint) => (((out * QUOTED) / BUY) * state.priceBps) / 10_000n;
  /** Underlying `nativeIn` buys at the current price. */
  const underlyingFor = (nativeIn: bigint) =>
    (((nativeIn * BUY) / QUOTED) * 10_000n) / state.priceBps;
  const executeTeleport = tx("xcm", () => {
    // The teleport leaves AH now and credits People a few reads later, minus remoteFee.
    state.inFlight = state.underlyingAh - remoteFee;
    state.underlyingAh = 0n;
    state.arrivalIn = opts.arrivalAfterReads ?? 3;
  });
  const api = {
    query: {
      AssetConversion: {
        Pools: { getEntries: async () => [{ keyArgs: [[NATIVE_LOC, UNDERLYING_LOC]] }] },
      },
      System: { Account: { getValue: async () => ({ data: { free: state.nativeAh }, nonce: 0 }) } },
      Assets: {
        Account: {
          getValue: async () => {
            if (state.swapCreditIn > 0 && --state.swapCreditIn === 0) {
              state.underlyingAh += state.pendingSwapCredit;
              state.pendingSwapCredit = 0n;
            }
            return { balance: state.underlyingAh };
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
          if (state.quoteFailuresLeft > 0) {
            state.quoteFailuresLeft -= 1;
            throw new Error("scripted transient quote failure");
          }
          // the quote is never needed once the transfer is in flight
          if (!opts.quoteAfterXcm && state.txs.some((t) => t.call === "xcm")) {
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
      // Teleport fee pricing, scripted small; the landing shortfall is driven by `remoteFee`.
      XcmPaymentApi: {
        query_xcm_weight: async () => ({
          success: true,
          value: { ref_time: 1_000_000n, proof_size: 1_000n },
        }),
        query_weight_to_asset_fee: async () => ({ success: true, value: 100n }),
        query_delivery_fees: async () => ({
          success: true,
          value: { value: [{ fun: { type: "Fungible", value: 0n } }] },
        }),
      },
    },
    tx: {
      PolkadotXcm: {
        // Dispatch fee pricing, scripted tiny.
        execute: (args: unknown) =>
          Object.assign(executeTeleport(args as never), {
            getEstimatedFees: async () => 1_000n,
          }),
      },
      AssetConversion: {
        swap_exact_tokens_for_tokens: tx(
          "swap",
          (args: { amount_in: bigint; amount_out_min: bigint }) => {
            const out = underlyingFor(args.amount_in);
            if (out < args.amount_out_min) return false; // the pool cannot fill the minimum
            state.nativeAh -= args.amount_in;
            if (opts.swapCreditAfterReads) {
              state.pendingSwapCredit += out;
              state.swapCreditIn = opts.swapCreditAfterReads;
            } else {
              state.underlyingAh += out;
            }
          },
        ),
      },
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
        underlyingAssetId: 50_000_413,
        peopleParaId: 1004,
        remoteFeeBuffer: BUFFER,
        keepNativeForFees: KEEP,
        slippagePct: 2,
        tickTimeoutMs: 1_000,
        submitTimeoutMs: 1_000,
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
  it("turns a deposit into CASH on People one tick at a time: swap, teleport, arrival, done", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 2 });
    // Nothing has arrived: the tick waits and the clock has not started.
    const idle = await drive(world, 1);
    expect(idle.steps).toEqual(["await-native"]);
    expect(idle.state.fundsSeenAt).toBeNull();

    world.state.nativeAh = MAX_IN + KEEP;
    const run = await drive(world, 6, idle.state);
    expect(run.steps).toEqual(["swap", "xcm", "await-arrival", "done"]);
    expect(run.txs).toEqual(["swap", "xcm"]);
    expect(run.state).toMatchObject({ swapSubmitted: true, xcmSubmitted: true });
    // The clock started on the first tick that saw funds, and only then.
    expect(run.state.fundsSeenAt).toBe(2_000);
    expect(world.state.underlyingPeople).toBeGreaterThanOrEqual(SETTLE);
    expect(run.transients).toEqual([]);
  });

  it("swaps everything above the fee reserve, not just the target", async () => {
    const world = scriptedWorld();
    world.state.nativeAh = FUND; // a generous sender
    await drive(world, 1);
    const swap = world.state.txs[0] as { args: { amount_in: bigint } };
    expect(swap.args.amount_in).toBe(FUND - KEEP);
    expect(world.state.nativeAh).toBe(KEEP);
  });

  it("holds after its own swap while the credit is not yet visible, instead of buying again", async () => {
    const world = scriptedWorld({ swapCreditAfterReads: 2 });
    world.state.nativeAh = MAX_IN + KEEP;
    const run = await drive(world, 3);
    // Tick 2 reads the native debited and no underlying yet: in flight, not "send a deposit".
    expect(run.steps).toEqual(["swap", "await-arrival", "xcm"]);
    expect(run.txs).toEqual(["swap", "xcm"]);
  });

  it("falls back to buying the target when the pool cannot absorb the whole deposit", async () => {
    const world = scriptedWorld({ poolDepth: MAX_IN });
    world.state.nativeAh = FUND;
    const run = await drive(world, 1);
    expect(run.steps).toEqual(["swap"]);
    const swap = world.state.txs[0] as { args: { amount_in: bigint } };
    expect(swap.args.amount_in).toBe(MAX_IN);
    expect(run.transients[0]).toContain("pool cannot absorb");
    // The surplus stays on the burner, reachable through its secret.
    expect(world.state.nativeAh).toBe(FUND - MAX_IN);
  });

  it("fails loudly on a shortfall, and a re-armed state can buy the deficit from a new deposit", async () => {
    // The remote fee eats past the buffer: People lands short of the target.
    const world = scriptedWorld({
      remoteFee: BUFFER * 3n,
      arrivalAfterReads: 1,
      quoteAfterXcm: true,
    });
    world.state.nativeAh = MAX_IN + KEEP;
    const state = freshTickState();
    await drive(world, 2, state); // swap, xcm
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(FundingShortfallError);
    expect(world.state.underlyingPeople).toBeLessThan(SETTLE);

    // Latches released and more native sent: the deficit is bought and moved.
    Object.assign(state, freshTickState());
    world.state.nativeAh = MAX_IN + KEEP;
    const retry = await drive(world, 6, state);
    expect(retry.steps.at(-1)).toBe("done");
    expect(retry.txs).toEqual(["swap", "xcm", "swap", "xcm"]);
  });

  it("with the xcm latch still held, a new deposit is never swapped", async () => {
    const world = scriptedWorld({ remoteFee: BUFFER * 3n, arrivalAfterReads: 1 });
    world.state.nativeAh = MAX_IN + KEEP;
    const state = freshTickState();
    await drive(world, 2, state);
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(FundingShortfallError);

    world.state.nativeAh = MAX_IN + KEEP;
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(FundingShortfallError);
    expect(world.state.txs.map((t) => t.call)).toEqual(["swap", "xcm"]);
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

  it("swaps a deposit sized before the pool moved 3% against it, and still lands the target", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 1 });
    await deposit(world);
    world.state.priceBps = 10_300n;
    const run = await drive(world, 4);
    expect(run.steps).toEqual(["swap", "xcm", "done"]);
    // The minimum is the requirement itself, not a slice of the expected fill.
    const swap = world.state.txs[0] as { args: { amount_out_min: bigint } };
    expect(swap.args.amount_out_min).toBe(BUY);
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

  it("reverts a swap the pool can no longer fill to the target, and retries on the next tick", async () => {
    // Funded to the exact gate at a flat price; the pool then moves inside the swap's own
    // block. The on-chain minimum refuses the short fill, so the buyer never receives less
    // than the target; the next tick re-reads the price and, once it is back, swaps.
    const world = scriptedWorld();
    world.state.nativeAh = QUOTED + KEEP;
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
      world.state.priceBps = 10_100n; // moves right after the gate has been judged
      return quoted;
    };
    await expect(drive(world, 1, state)).rejects.toThrow(/swap dispatch rejected/);
    expect(world.state.nativeAh).toBe(QUOTED + KEEP); // nothing spent
    expect(state.swapSubmitted).toBe(false);

    api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens = quoteAtFlatPrice;
    world.state.priceBps = 10_000n;
    const retry = await drive(world, 1, state);
    expect(retry.steps).toEqual(["swap"]);
    expect(state.swapSubmitted).toBe(true);
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
