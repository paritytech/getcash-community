// The pool funding pipeline: converts the NATIVE token delivered to the
// ephemeral on Asset Hub into the coinage UNDERLYING on the People chain: an exact-IN
// AssetConversion swap, then an XCM transfer of the underlying to the ephemeral's own address,
// both signed by the ephemeral. The handoff session's funded-gate (underlying on People) takes
// over from there; this pipeline never touches the settle.
//
// EVERYTHING THE BURNER HOLDS IS CONVERTED AND MOVED. The burner serves one request, and
// the claim sweeps its whole balance, so anything left behind is stranded: the swap spends
// the full native balance above the fee reserve and the XCM carries the full holding. The
// target only decides WHEN to swap, never how much. One exception: a deposit the pool is
// too shallow to absorb whole falls back to buying the target, so the request still
// completes; the unconverted surplus stays on the burner (recoverable via its secret).
//
// THE CLOCK STARTS WHEN FUNDS ARE SEEN, not when the run does. Waiting for someone to send
// a deposit has no natural bound (an off-screen request may wait hours), while the
// conversion after it does: a submitted swap or transfer that never credits is a fault.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the three balances and performs the next
// step; a reload resumes by re-reading chain state, never by trusting memory. Known
// bounded caveat: a cold re-entry during the ~30s XCM flight sees underlying on neither
// chain and may buy once more if enough native remains to clear the swap gate; the surplus
// lands on People and is claimable/sweepable.
//
// FAILURE CONTAINMENT: a tick that throws (RPC blip, transient quote failure, a swap the
// pool could no longer fill to the target) is retried on the next tick; only
// the overall timeout and a detected arrival shortfall are terminal. Pool reads are LAZY:
// the gating quote only when the decision needs it (swap vs await-native), the teleport's
// fee pricing only at the xcm step — never while funds are in flight and never on the
// completion check.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import {
  buildSelfFundingTeleport,
  estimateTeleportFeesCash,
  reserveForDispatchFee,
} from "./teleport";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type AssetLocation = Parameters<AssetHubApi["query"]["AssetConversion"]["Pools"]["getValue"]>[0][0];

/** 'await-arrival' covers both in-flight waits: a submitted swap whose credit is not yet
 *  visible on AH, and the XCM crossing to People. */
export type FundingStep = "await-native" | "swap" | "xcm" | "await-arrival" | "done";

/** Extra underlying bought to cover the teleport's fees, which it pays in the underlying.
 *  Fallback when the caller passes no live estimate; 0.3 at 6 decimals. */
export const DEFAULT_REMOTE_FEE_BUFFER = 300_000n;
/** Native the burner keeps to dispatch the swap. Fallback when the caller passes no live
 *  estimate; 0.005 at 10 decimals. */
export const DEFAULT_KEEP_NATIVE_FOR_FEES = 50_000_000n;
/** Headroom the deposit is asked ABOVE the live pool quote, percent. Applied once, when the
 *  deposit is sized: the swap gate checks the plain quote, so this is exactly how far the pool
 *  may move against the deposit between sizing and swapping before it stops clearing the gate.
 *  The surplus is swapped and claimed with the rest, so the buyer never receives less than the
 *  target and receives up to this much more. 5 to account for shallow liquidity in Paseo AH
 *  next v2 Pool. */
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

/** Terminal: the XCM arrived but the remote fee exceeded remoteFeeBuffer, leaving the People
 *  balance below the settle target. */
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
  underlyingAh: bigint;
  underlyingPeople: bigint;
}

export interface FundingTargets {
  /** What the settle claims (base units); the pipeline must land ≥ this on People. */
  settleAmount: bigint;
  /** See DEFAULT_REMOTE_FEE_BUFFER. */
  remoteFeeBuffer: bigint;
  /** Native retained on AH to pay the swap + XCM local fees. */
  keepNativeForFees: bigint;
  /** Native the pool quotes RIGHT NOW for settle+buffer: the swap gate, no headroom. */
  nativeNeeded: bigint;
}

/** Pure next-step decision from observed balances. */
export function decideStep(b: FundingBalances, t: FundingTargets): FundingStep {
  if (b.underlyingPeople >= t.settleAmount) return "done";
  if (b.underlyingAh > 0n) return "xcm"; // move whatever was bought, in full
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

/** Fresh exact-IN quote: the underlying `nativeIn` buys right now. The swap spends the
 *  burner's whole native balance; this asks whether the pool can take that much at all.
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

/** Fresh exact-out quote: the native that buys `underlyingOut` right now. What the swap gate
 *  compares the burner's balance against; no headroom, so a deposit that carries any is
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
 *  quote for settle+buffer plus the headroom (DEFAULT_SLIPPAGE_PCT), plus the retained fee
 *  native. The single source of truth for app-side budget sizing; uses the same defaults as
 *  the pipeline.
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
  /** Set once the swap is submitted; one buy per run. */
  swapSubmitted: boolean;
  xcmSubmitted: boolean;
  /** People balance when the XCM left; arrival = growth above this. */
  peopleAtXcm: bigint;
  /** When the first tick saw funds (ms); null while the deposit is still awaited. */
  fundsSeenAt: number | null;
}

export const freshTickState = (): TickState => ({
  swapSubmitted: false,
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
  underlyingAssetId: number;
  peopleParaId: number;
  remoteFeeBuffer: bigint;
  keepNativeForFees: bigint;
  slippagePct: number;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  /** Extra options merged into every signAndSubmit this tick makes (the swap and the XCM). */
  signOptions?: Record<string, unknown>;
  readUnderlyingOnPeople: (ss58: string) => Promise<bigint>;
  now: () => number;
  onTx?: (info: { call: "swap" | "xcm"; txHash: string; block?: number }) => void;
  /** Reports swallowed in-tick conditions such as the shallow-pool fallback. */
  onTransientError?: (error: unknown) => void;
  onBeforeSubmit?: (call: "swap" | "xcm") => Promise<void> | void;
}

export interface TickOutcome {
  /** The effective step after the in-flight overrides. */
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
  const [account, holding, underlyingPeople] = await bounded(
    Promise.all([
      api.query.System.Account.getValue(address),
      api.query.Assets.Account.getValue(input.underlyingAssetId, address),
      input.readUnderlyingOnPeople(address),
    ]),
    input.tickTimeoutMs,
    "tick balance reads",
  );
  const balances: FundingBalances = {
    nativeAh: account?.data.free ?? 0n,
    underlyingAh: holding?.balance ?? 0n,
    underlyingPeople,
  };

  if (
    state.xcmSubmitted &&
    balances.underlyingAh === 0n &&
    balances.underlyingPeople > state.peopleAtXcm &&
    balances.underlyingPeople < input.settleAmount
  ) {
    // The transfer arrived yet the target is missed: the remote fee ate past the buffer.
    throw new FundingShortfallError(balances.underlyingPeople, input.settleAmount);
  }

  // Only the swap-vs-await-native decision needs the pool price.
  const needsQuote =
    !state.xcmSubmitted &&
    balances.underlyingPeople < input.settleAmount &&
    balances.underlyingAh === 0n;
  // The quote GATES the swap (does what arrived buy the target right now?), it does not
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
  // Hold in await-arrival while a submitted XCM or swap has not yet credited.
  const inFlight =
    (state.xcmSubmitted && step !== "done") ||
    (state.swapSubmitted && (step === "swap" || step === "await-native"));
  const effective = inFlight ? "await-arrival" : step;
  // Funds seen: from here the conversion is on the clock.
  if (state.fundsSeenAt === null && effective !== "await-native") state.fundsSeenAt = input.now();

  if (effective === "done") {
    return { step: "done", balances, submitted: false };
  }

  if (effective === "swap") {
    // Convert everything above the fee reserve, not just enough for the target.
    let spend = balances.nativeAh - input.keepNativeForFees;
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
      // the remote fee then eat past the buffer, the shortfall below fires although native
      // remains: a fresh run re-buys the deficit from that surplus, this run does not.)
      // Reported through the transient hook because it is the one observability channel for
      // a swallowed condition.
      const target = (nativeNeeded * BigInt(Math.round((100 + input.slippagePct) * 100))) / 10_000n;
      spend = target < spend ? target : spend;
      input.onTransientError?.(
        new Error(
          `pool cannot absorb the whole balance in one swap; buying the target with ${spend} instead`,
        ),
      );
      absorbable = await bounded(
        quoteUnderlyingOut(api, pool, spend),
        input.tickTimeoutMs,
        "pool quote (target)",
      );
      if (absorbable === null) throw new Error("pool cannot quote even the target amount");
    }
    // The minimum is the REQUIREMENT, not a percentage of the expected fill: the buyer must
    // receive at least settle+buffer, so a swap that would land under it reverts on chain and
    // the next tick re-reads the price and retries. Anything above lands as extra CASH.
    const tx = api.tx.AssetConversion.swap_exact_tokens_for_tokens({
      path: [pool.native, pool.underlying],
      amount_in: spend,
      amount_out_min: buyNow,
      send_to: address,
      keep_alive: false,
    });
    await input.onBeforeSubmit?.("swap");
    const res = await bounded(
      tx.signAndSubmit(input.signer, input.signOptions),
      input.submitTimeoutMs,
      "swap submit",
    );
    input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number });
    // An exact-in swap fails when the pool cannot return the target (it moved between the
    // gate's quote and this block), or when the balance it was sized from is already spent
    // (a reload starts a fresh run, and the previous run's swap may still be landing).
    if (!res.ok) throw new Error("swap dispatch rejected (pool moved, or already swapped)");
    state.swapSubmitted = true;
    return { step: effective, balances, submitted: true };
  }

  if (effective === "xcm") {
    // Teleport the whole underlying holding to People, paying every fee (local execution,
    // delivery, destination execution) out of the underlying. Fees are priced fresh here.
    const fees = await bounded(
      estimateTeleportFeesCash({
        api,
        pool,
        beneficiaryHex: input.beneficiaryHex,
        peopleParaId: input.peopleParaId,
        amount: balances.underlyingAh,
        // Prices the delivery fee from the dry-run's real forwarded program.
        dryRunFrom: address,
      }),
      input.tickTimeoutMs,
      "teleport fee estimate",
    );
    // The burner holds no native now, so a slice of the holding stays behind to pay the
    // teleport's dispatch fee in the underlying.
    const teleportOf = (withdrawAmount: bigint) =>
      buildSelfFundingTeleport({
        pool,
        withdrawAmount,
        payFeesCash: fees.payFeesCash,
        // The remote RefundSurplus returns the unused part to the burner on People.
        remoteFeesCash: fees.payFeesCash,
        beneficiaryHex: input.beneficiaryHex,
        peopleParaId: input.peopleParaId,
        // The measured weight, declared as the ceiling.
        maxWeight: fees.maxWeight,
      });
    const dispatchReserve = await bounded(
      reserveForDispatchFee({
        api,
        pool,
        // Probe with the full holding; the fee has a per-byte length component.
        execArgs: teleportOf(balances.underlyingAh),
        from: address,
      }),
      input.tickTimeoutMs,
      "teleport dispatch fee",
    );
    if (balances.underlyingAh <= dispatchReserve) {
      throw new Error(
        `holding ${balances.underlyingAh} does not cover the teleport's dispatch fee ${dispatchReserve}`,
      );
    }
    const tx = api.tx.PolkadotXcm.execute(teleportOf(balances.underlyingAh - dispatchReserve));
    await input.onBeforeSubmit?.("xcm");
    const res = await bounded(
      // Charged in the underlying, not native.
      tx.signAndSubmit(input.signer, { asset: pool.underlying as never, ...input.signOptions }),
      input.submitTimeoutMs,
      "xcm submit",
    );
    input.onTx?.({ call: "xcm", txHash: res.txHash, block: res.block?.number });
    if (!res.ok) throw new Error("xcm teleport dispatch rejected");
    state.peopleAtXcm = balances.underlyingPeople;
    state.xcmSubmitted = true;
    return { step: effective, balances, submitted: true };
  }

  return { step: effective, balances, submitted: false };
}
