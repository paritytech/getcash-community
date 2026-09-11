// The pool funding pipeline: converts the native token delivered to the ephemeral on Asset Hub
// into the coinage underlying on the People chain with one extrinsic signed by the ephemeral. The
// program pays its own fees in native, exchanges the rest through the AssetConversion pool inside
// the XCM holding, and teleports the result to the ephemeral's People address. The handoff
// session's funded gate takes over from there; this pipeline never touches the settle.
//
// EVERYTHING THE BURNER HOLDS IS CONVERTED AND MOVED. The burner serves one request and the claim
// sweeps its whole balance, so anything left behind is stranded. The program withdraws the full
// native balance minus its dispatch fee and converts everything the fees leave. The target decides
// when to convert, never how much. One exception: a deposit the pool cannot absorb whole falls
// back to buying the target, and the surplus stays on the burner, recoverable with its secret.
//
// THE CLOCK STARTS WHEN FUNDS ARE SEEN, not when the run does. Waiting for a deposit has no
// natural bound, while the conversion after it does: a submitted program that never credits
// People is a fault.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the two balances and performs the next step; a
// reload resumes from chain state, never from memory. A cold re-entry during the XCM flight reads
// as await-native until the arrival; nothing is bought twice because no native is left behind.
//
// FAILURE CONTAINMENT: a tick that throws is retried on the next tick; only the overall timeout
// and a detected arrival shortfall are terminal. A rejected program rolls back whole and costs its
// dispatch fee, and the next tick re-prices and retries. Pool reads are lazy: the gating quote only
// when the decision needs it, the fee pricing only at the submitting step.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import { describeDispatchError } from "./dispatch-error";
import {
  buildFundingProgram,
  destinationEarmark,
  estimateFundingProgramFees,
} from "./funding-program";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type AssetLocation = Parameters<AssetHubApi["query"]["AssetConversion"]["Pools"]["getValue"]>[0][0];

/** The step a tick performs or waits in. 'swap' submits the program that exchanges the native and
 *  teleports the result in one XCM. 'await-arrival' holds while that XCM has not yet credited
 *  People. */
export type FundingStep = "await-native" | "swap" | "await-arrival" | "done";

/** Extra underlying bought to cover the destination's execution fee, the one fee paid in the
 *  underlying. The remote RefundSurplus returns what it does not consume, so an over-buy lands as
 *  extra underlying. Fallback when the caller passes no live estimate; 0.3 at 6 decimals. */
export const DEFAULT_REMOTE_FEE_BUFFER = 300_000n;
/** Native the deposit carries beyond the pool quote for the program's own fees: dispatch, local
 *  execution and delivery. A sizing figure, not a reserve: everything the fees leave is converted.
 *  Fallback when the caller passes no live estimate; 0.02 at 10 decimals. */
export const DEFAULT_KEEP_NATIVE_FOR_FEES = 200_000_000n;
/** Headroom the deposit is asked ABOVE the live pool quote, percent. Applied once, when the
 *  deposit is sized: the conversion gate checks the plain quote, so this is exactly how far the
 *  pool may move against the deposit between sizing and converting before it stops clearing the
 *  gate. The surplus is converted and claimed with the rest, so the buyer never receives less
 *  than the target and receives up to this much more. 5 to account for shallow liquidity in
 *  Paseo AH next v2 Pool. */
export const DEFAULT_SLIPPAGE_PCT = 5;
/** Bound on a tick's chain reads (balances, pool quote, pool discovery). A transport that
 *  dies without rejecting leaves reads pending forever; unbounded, one such tick would
 *  freeze the loop silently, with no transient ever reported. */
export const DEFAULT_TICK_TIMEOUT_MS = 20_000;
/** Bound on a submitted extrinsic's resolution. */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 180_000;

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Terminal: the XCM arrived but the destination fee exceeded remoteFeeBuffer, leaving the
 *  People balance below the settle target. */
export class FundingShortfallError extends Error {
  constructor(
    readonly arrived: bigint,
    readonly needed: bigint,
  ) {
    super(
      `funding shortfall: ${arrived} of ${needed} underlying arrived on People; ` +
        "the XCM remote fee exceeded remoteFeeBuffer; retry with a larger buffer",
    );
    this.name = "FundingShortfallError";
  }
}

export interface FundingBalances {
  nativeAh: bigint;
  underlyingPeople: bigint;
}

export interface FundingTargets {
  /** What the settle claims (base units); the pipeline must land ≥ this on People. */
  settleAmount: bigint;
  /** See DEFAULT_REMOTE_FEE_BUFFER. */
  remoteFeeBuffer: bigint;
  /** See DEFAULT_KEEP_NATIVE_FOR_FEES. */
  keepNativeForFees: bigint;
  /** Native the pool quotes RIGHT NOW for settle+buffer: the conversion gate, no headroom. */
  nativeNeeded: bigint;
}

/** Pure next-step decision from observed balances. */
export function decideStep(b: FundingBalances, t: FundingTargets): FundingStep {
  if (b.underlyingPeople >= t.settleAmount) return "done";
  if (b.nativeAh >= t.nativeNeeded + t.keepNativeForFees) return "swap";
  return "await-native";
}

type Junction = { type?: string; value?: unknown };

const junctionsOf = (loc: AssetLocation): Junction[] => {
  const interior = (loc as { interior?: { type?: string; value?: unknown } }).interior;
  if (interior?.value === undefined) return [];
  return Array.isArray(interior.value) ? interior.value : [interior.value as Junction];
};

/** Structural junction match (number/bigint/string-agnostic, order-independent). */
const isUnderlying = (loc: AssetLocation, assetId: number): boolean =>
  junctionsOf(loc).some(
    (j) => j?.type === "GeneralIndex" && BigInt(j.value as never) === BigInt(assetId),
  );

/** The chain's native asset as AssetConversion keys it: an interior-Here location. */
const isNative = (loc: AssetLocation): boolean =>
  ((loc as { parents?: number }).parents ?? 0) <= 1 &&
  (loc as { interior?: { type?: string } }).interior?.type === "Here";

/** Find the native/underlying pool and return both sides' exact Location keys. */
export async function discoverPool(
  api: AssetHubApi,
  underlyingAssetId: number,
): Promise<{ native: AssetLocation; underlying: AssetLocation }> {
  const pools = await api.query.AssetConversion.Pools.getEntries();
  for (const entry of pools) {
    const [a, b] = entry.keyArgs[0] ?? [];
    if (a === undefined || b === undefined) continue;
    if (isUnderlying(a, underlyingAssetId) && isNative(b)) return { native: b, underlying: a };
    if (isUnderlying(b, underlyingAssetId) && isNative(a)) return { native: a, underlying: b };
  }
  throw new Error(`no native AssetConversion pool found for underlying asset ${underlyingAssetId}`);
}

/** Fresh exact-IN quote: the underlying `nativeIn` buys right now. The funding program gives the
 *  burner's whole native balance above its fees; this asks whether the pool can take that much.
 *
 *  `null` when the pool cannot price this much (too shallow for the amount): that is an
 *  answer about the pool, not a transport failure, so it is returned rather than thrown and
 *  the caller can size down instead of retrying the same question every tick. */
export async function quoteUnderlyingOut(
  api: AssetHubApi,
  pool: { native: AssetLocation; underlying: AssetLocation },
  nativeIn: bigint,
): Promise<bigint | null> {
  const quoted = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    pool.native,
    pool.underlying,
    nativeIn,
    true,
  );
  return quoted === undefined ? null : quoted;
}

/** Fresh exact-out quote: the native that buys `underlyingOut` right now. What the conversion
 *  gate compares the burner's balance against; no headroom, so a deposit that carries any is
 *  admitted as long as the pool has not moved past it. */
export async function quoteNativeIn(
  api: AssetHubApi,
  pool: { native: AssetLocation; underlying: AssetLocation },
  underlyingOut: bigint,
): Promise<bigint> {
  const quoted = await api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
    pool.native,
    pool.underlying,
    underlyingOut,
    true,
  );
  if (quoted === undefined) {
    throw new Error("pool cannot quote this amount: insufficient liquidity");
  }
  return quoted;
}

/** The exact-out quote plus `slippagePct` headroom: what the deposit is ASKED for. The only
 *  place the headroom is applied (see DEFAULT_SLIPPAGE_PCT); the gate uses the plain quote. */
export async function quoteNativeInMax(
  api: AssetHubApi,
  pool: { native: AssetLocation; underlying: AssetLocation },
  underlyingOut: bigint,
  slippagePct: number,
): Promise<bigint> {
  const quoted = await quoteNativeIn(api, pool, underlyingOut);
  return (quoted * BigInt(Math.round((100 + slippagePct) * 100))) / 10_000n;
}

/** The native budget the rail must deliver for `settleAmount` to be claimable: the pool
 *  quote for settle+buffer plus the headroom (DEFAULT_SLIPPAGE_PCT), plus the native the
 *  funding program spends on its own fees. The single source of truth for app-side budget
 *  sizing; uses the same defaults as the pipeline.
 *
 *  No credit is netted off. Each request has its own burner, so there is nothing on it to
 *  net against, and a quote that shrinks itself against a balance the buyer cannot see is
 *  a quote they cannot check. */
export async function sizeNativeBudget(input: {
  client: PolkadotClient;
  underlyingAssetId: number;
  settleAmount: bigint;
  remoteFeeBuffer?: bigint;
  slippagePct?: number;
  keepNativeForFees?: bigint;
}): Promise<bigint> {
  const keep = input.keepNativeForFees ?? DEFAULT_KEEP_NATIVE_FOR_FEES;
  const buyTarget = input.settleAmount + (input.remoteFeeBuffer ?? DEFAULT_REMOTE_FEE_BUFFER);
  const api = input.client.getTypedApi(paseo_next_v2);
  const pool = await discoverPool(api, input.underlyingAssetId);
  const nativeInMax = await quoteNativeInMax(
    api,
    pool,
    buyTarget,
    input.slippagePct ?? DEFAULT_SLIPPAGE_PCT,
  );
  return nativeInMax + keep;
}

/** Cross-tick memory for one conversion. The driver persists it between ticks; `tickOnce`
 *  mutates it in place. */
export interface TickState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** Set once the program landed; holds the run in await-arrival. */
  xcmSubmitted: boolean;
  /** People balance when the XCM left; arrival = growth above this. */
  peopleAtXcm: bigint;
  /** When the first tick saw funds (ms); null while the deposit is still awaited. */
  fundsSeenAt: number | null;
}

export const freshTickState = (): TickState => ({
  attempts: 0,
  xcmSubmitted: false,
  peopleAtXcm: 0n,
  fundsSeenAt: null,
});

export interface TickOnceInput {
  api: AssetHubApi;
  /** Pool keys; discovered once and passed in. */
  pool: { native: AssetLocation; underlying: AssetLocation };
  /** The burner, passed as address and signer. */
  address: string;
  signer: PolkadotSigner;
  beneficiaryHex: string;
  settleAmount: bigint;
  peopleParaId: number;
  remoteFeeBuffer: bigint;
  keepNativeForFees: bigint;
  slippagePct: number;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  /** Extra options merged into the signAndSubmit this tick makes. */
  signOptions?: Record<string, unknown>;
  readUnderlyingOnPeople: (ss58: string) => Promise<bigint>;
  now: () => number;
  onTx?: (info: { call: "swap"; txHash: string; block?: number }) => void;
  /** Reports swallowed in-tick conditions such as the shallow-pool fallback. */
  onTransientError?: (error: unknown) => void;
  onBeforeSubmit?: (call: "swap") => Promise<void> | void;
}

export interface TickOutcome {
  /** The effective step after the in-flight override. */
  step: FundingStep;
  balances: FundingBalances;
  /** A transaction went out and landed ok. */
  submitted: boolean;
}

/**
 * One reading of the balances and at most one action on them. Retryable by calling again;
 * the only terminal signals are the returned "done" and a thrown FundingShortfallError.
 */
export async function tickOnce(input: TickOnceInput, state: TickState): Promise<TickOutcome> {
  const { api, pool, address } = input;
  const buyAmount = input.settleAmount + input.remoteFeeBuffer;
  const [account, underlyingPeople] = await bounded(
    Promise.all([
      api.query.System.Account.getValue(address),
      input.readUnderlyingOnPeople(address),
    ]),
    input.tickTimeoutMs,
    "tick balance reads",
  );
  const balances: FundingBalances = {
    nativeAh: account?.data.free ?? 0n,
    underlyingPeople,
  };

  if (
    state.xcmSubmitted &&
    balances.underlyingPeople > state.peopleAtXcm &&
    balances.underlyingPeople < input.settleAmount
  ) {
    // The transfer arrived yet the target is missed: the destination fee ate past the buffer.
    throw new FundingShortfallError(balances.underlyingPeople, input.settleAmount);
  }

  // Only the convert-vs-await-native decision needs the pool price.
  const needsQuote = !state.xcmSubmitted && balances.underlyingPeople < input.settleAmount;
  // The quote GATES the conversion (does what arrived buy the target right now?), it does not
  // bound the spend. The PLAIN quote: the deposit was asked with headroom on top, and
  // re-applying it here would demand that headroom twice and strand a deposit on any move.
  // Net of what People already holds, so a run resumed after a partial arrival does not
  // demand the whole deposit a second time.
  const buyNow = buyAmount > balances.underlyingPeople ? buyAmount - balances.underlyingPeople : 0n;
  const nativeNeeded = needsQuote
    ? await bounded(quoteNativeIn(api, pool, buyNow), input.tickTimeoutMs, "pool quote")
    : 0n;
  const step = decideStep(balances, {
    settleAmount: input.settleAmount,
    remoteFeeBuffer: input.remoteFeeBuffer,
    keepNativeForFees: input.keepNativeForFees,
    nativeNeeded,
  });
  // Hold in await-arrival while the submitted XCM has not yet credited People. A stale read right
  // after the submit still shows the native, and without this latch it would be converted twice.
  const effective = state.xcmSubmitted && step !== "done" ? "await-arrival" : step;
  // Funds seen: from here the conversion is on the clock.
  if (state.fundsSeenAt === null && effective !== "await-native") state.fundsSeenAt = input.now();

  if (effective === "done") {
    return { step: "done", balances, submitted: false };
  }

  if (effective === "swap") {
    // Withdraw the whole native balance minus the dispatch fee, pay the XCM's fees in native,
    // exchange the rest inside the holding, and teleport the result to the burner on People.
    const earmark = destinationEarmark(buyNow, input.remoteFeeBuffer);
    const fees = await bounded(
      estimateFundingProgramFees({
        api,
        pool,
        beneficiaryHex: input.beneficiaryHex,
        peopleParaId: input.peopleParaId,
        nativeBalance: balances.nativeAh,
        minUnderlyingOut: buyNow,
        remoteFeesCash: earmark,
        feeProbeAddress: address,
        // The burner holds the native, so the delivery fee is priced from the real forwarded
        // program.
        dryRunFrom: address,
      }),
      input.tickTimeoutMs,
      "funding program fee estimate",
    );
    const payFeesNative = fees.payFeesNative;
    // Convert everything the fees leave, not just enough for the target.
    let spend = balances.nativeAh - fees.dispatchNative - payFeesNative;
    if (spend <= 0n) {
      throw new Error(
        `deposit ${balances.nativeAh} cannot cover the funding program's own fees ` +
          `(dispatch ${fees.dispatchNative} + PayFees ${payFeesNative})`,
      );
    }
    let absorbable = await bounded(
      quoteUnderlyingOut(api, pool, spend),
      input.tickTimeoutMs,
      "pool quote (whole balance)",
    );
    if (absorbable === null) {
      // The pool is too shallow for the whole deposit. Buying just the target (the quote
      // that admitted this tick, with the headroom as room for the fill) still completes
      // the request; retrying the same oversized quote every tick would only run the clock
      // out. The surplus native stays on the burner, reachable through its secret. (Should
      // the destination fee then eat past the buffer, the shortfall above fires although native
      // remains: a fresh run re-buys the deficit from that surplus, this run does not.)
      // Reported through the transient hook because it is the one observability channel for
      // a swallowed condition.
      const target = (nativeNeeded * BigInt(Math.round((100 + input.slippagePct) * 100))) / 10_000n;
      spend = target < spend ? target : spend;
      input.onTransientError?.(
        new Error(
          `pool cannot absorb the whole balance in one exchange; buying the target with ${spend} instead`,
        ),
      );
      absorbable = await bounded(
        quoteUnderlyingOut(api, pool, spend),
        input.tickTimeoutMs,
        "pool quote (target)",
      );
      if (absorbable === null) throw new Error("pool cannot quote even the target amount");
    }
    // The floor is the requirement itself, not a share of the expected fill. A fill under it would
    // fail the whole program and cost a dispatch fee, so a quote already under it waits for the
    // next tick instead of submitting. Anything above lands as extra CASH.
    if (absorbable < buyNow) {
      throw new Error(
        `pool quote ${absorbable} for the spend is below the target ${buyNow}; waiting for the price`,
      );
    }
    const execArgs = buildFundingProgram({
      pool,
      withdrawNative: spend + payFeesNative,
      payFeesNative,
      minUnderlyingOut: buyNow,
      remoteFeesCash: earmark,
      beneficiaryHex: input.beneficiaryHex,
      peopleParaId: input.peopleParaId,
      // The weighed weight, declared as the ceiling.
      maxWeight: fees.maxWeight,
    });
    const tx = api.tx.PolkadotXcm.execute(execArgs);
    await input.onBeforeSubmit?.("swap");
    // Counted before the broadcast, so a submit whose answer is lost is still counted.
    state.attempts += 1;
    const res = await bounded(
      // The dispatch fee is paid in native.
      tx.signAndSubmit(input.signer, input.signOptions),
      input.submitTimeoutMs,
      "funding program submit",
    );
    input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number });
    // A rejected program rolls back whole: the deposit stays native and the next tick re-prices
    // and retries. It happens when the pool moved past the floor, a fee allowance fell short, or
    // the balance was already spent by an earlier run.
    if (!res.ok) {
      throw new Error(
        `funding program dispatch rejected: ${describeDispatchError(res.dispatchError, execArgs)}`,
      );
    }
    state.xcmSubmitted = true;
    state.peopleAtXcm = balances.underlyingPeople;
    return { step: effective, balances, submitted: true };
  }

  return { step: effective, balances, submitted: false };
}
