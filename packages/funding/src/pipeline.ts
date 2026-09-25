// The funding pipeline: converts the deposit delivered to the ephemeral on Asset Hub into the
// coinage underlying on the People chain with one extrinsic signed by the ephemeral, through the
// tier the request was quoted (route.ts) and never another. On the pool tier the deposit is the
// native: one program pays its own fees in native, exchanges the rest through the AssetConversion
// pool inside the XCM holding, and teleports the result to the ephemeral's People address. On the
// PSM tier the deposit is the external (USDT): one batch mints CASH through the PSM and teleports
// it, the dispatch fee and the XCM's own fees both paid in the external, the latter from an
// allowance the mint leaves on the burner and the program refunds the unspent part of
// (psm-batch.ts). The pool tier fed with a stable, USDC or USDT the PSM will not serve, is the
// stable pool tier: one program pays its fees in the stable as the PSM tier does, exchanges the
// stable for the native and the native for CASH inside the holding, and teleports the CASH. The
// handoff session's funded gate takes over from there; this pipeline never touches the settle.
//
// EVERYTHING THE BURNER HOLDS IS CONVERTED AND MOVED. The burner serves one request and the claim
// sweeps its whole balance, so anything left behind is stranded. The program withdraws the full
// deposit minus its dispatch fee and converts everything the fees leave. The target decides when
// to convert, never how much. One exception, on the pool tier: a deposit the pool cannot absorb
// whole falls back to buying the target, and the surplus stays on the burner, recoverable with its
// secret. The PSM's rate is fixed, so on its tier the surplus simply lands as extra CASH; what its
// tier keeps back is the external's min_balance, which the burner's account must hold to survive
// the batch, and it stays there with the unspent fee allowance (psm-batch.ts). The stable pool
// tier keeps back the same, and falls back to the target as the native pool tier does.
//
// THE CLOCK STARTS WHEN FUNDS ARE SEEN, not when the run does. Waiting for a deposit has no
// natural bound, while the conversion after it does: a submitted program that never credits
// People is a fault.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the two balances and performs the next step; a
// reload resumes from chain state, never from memory. A cold re-entry during the XCM flight reads
// as await-native until the arrival; nothing is bought twice because no native is left behind.
//
// FAILURE CONTAINMENT: a tick that throws is retried on the next tick; only the overall timeout, a
// detected arrival shortfall and the PSM's third refusal are terminal. Before the program is paid
// for, both chains run it in a dry run, and one that would fail, trap assets or land short is not
// submitted. A program rejected at inclusion anyway rolls back whole and costs its dispatch fee,
// and the next tick re-prices and retries. Chain reads are lazy: the gating quote or fee estimate
// only when the decision needs it, the dry run only at the submitting step.
//
// A PSM REFUSAL IS RETRIED THREE TIMES, THEN HELD. A mint the PSM refuses (the pair paused, or the
// mint over its ceiling) is tried again on the next tick, and the third refusal stops the run with
// FundingHeldError: the deposit stays on the burner, recoverable through its secret, until a
// resume with a fresh counter. Never the pool instead: the tier was quoted and committed, and
// converting at a rate the buyer did not agree to is worse than waiting. Only the PSM's own
// refusals count; a transport error or a timeout is retried as any other, without limit.

import { paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import { describeDispatchError, psmRefusalKind, type PsmRefusalKind } from "./dispatch-error";
import {
  buildFundingProgram,
  buildStableFundingProgram,
  destinationEarmark,
  dryRunFundingProgram,
  estimateFundingProgramFees,
  estimateStableProgramFees,
  ProgramRejectedError,
  withFeeMargin,
  type PeopleApi,
  type Pool,
  type StableLegFees,
} from "./funding-program";
import {
  buildPsmBatch,
  dryRunPsmBatch,
  estimatePsmBatchFees,
  psmBatchTxOptions,
  psmMintOut,
  sizePsmMint,
  type PsmBatchFees,
  type PsmRoute,
} from "./psm-batch";
import {
  depositTokenOf,
  isStablePoolRoute,
  type ConversionRoute,
  type StablePoolRoute,
} from "./route";
import { stableTxOptions } from "./stable";

type AssetHubApi = TypedApi<typeof paseo_next_v2>;
type AssetLocation = Parameters<AssetHubApi["query"]["AssetConversion"]["Pools"]["getValue"]>[0][0];

/** The step a tick performs or waits in. 'await-native' waits for the deposit the route expects,
 *  the native on the pool tier and the external on the PSM tier; 'swap' submits the one
 *  transaction that converts it and teleports the result, an exchange or a mint; 'await-arrival'
 *  holds while that XCM has not yet credited People. The two names predate the PSM tier and are
 *  persisted in TopUpRecord and the worker's job blob, so they keep their names and widen their
 *  meaning. */
export type FundingStep = "await-native" | "swap" | "await-arrival" | "done";

/** Extra underlying bought to cover the destination's execution fee, the one fee paid in the
 *  underlying. The remote RefundSurplus returns what it does not consume, so an over-buy lands as
 *  extra underlying. Fallback when the caller passes no live estimate (estimateDestinationFeeCash),
 *  which is the primary source; 0.001 at 6 decimals, some twenty times the 43 base units People
 *  charges today at every amount, so it survives People's fee constants moving by an order of
 *  magnitude while over-buying a thousandth of a CASH when it does fire. */
export const DEFAULT_REMOTE_FEE_BUFFER = 1_000n;
/** Native the deposit carries beyond the pool quote for the program's own fees: dispatch, local
 *  execution and delivery. A sizing figure, not a reserve: everything the fees leave is converted.
 *  Fallback when the caller passes no live estimate; 0.02 at 10 decimals. Pool tier only: the
 *  PSM tier's fees come from its batch's live estimate. */
export const DEFAULT_KEEP_NATIVE_FOR_FEES = 200_000_000n;
/** Headroom the deposit is asked ABOVE the live pool quote, percent. Applied once, when the
 *  deposit is sized: the conversion gate checks the plain quote, so this is exactly how far the
 *  pool may move against the deposit between sizing and converting before it stops clearing the
 *  gate. The surplus is converted and claimed with the rest, so the buyer never receives less
 *  than the target and receives up to this much more. 5 to account for shallow liquidity in
 *  Paseo AH next v2 Pool. Pool tier only: the PSM's rate does not move. */
export const DEFAULT_SLIPPAGE_PCT = 5;
/** PSM refusals of the mint before the run is held. */
export const MAX_PSM_REFUSALS = 3;
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

/** Terminal: the PSM would not mint. The run stops and the deposit stays on the burner,
 *  recoverable through its secret; it is not sent through the pool instead.
 *
 *  Either the PSM was unavailable for MAX_PSM_REFUSALS ticks — paused, or over its ceiling — where
 *  a resume with a fresh counter tries again once the ceiling has been raised; or it refused the
 *  swap as quoted, where a resume replays the same frozen rate and amount and fails identically,
 *  and only a fresh quote can serve the buyer. */
export class FundingHeldError extends Error {
  constructor(
    readonly reason: string,
    readonly kind: PsmRefusalKind = "unavailable",
  ) {
    super(
      kind === "unavailable"
        ? `funding held: the PSM refused the mint ${MAX_PSM_REFUSALS} times, last: ${reason}`
        : `funding held: the PSM will not mint this swap as quoted: ${reason}`,
    );
    this.name = "FundingHeldError";
  }
}

export interface FundingBalances {
  /** The deposit on Asset Hub in the asset the route expects: the native on the pool tier, the
   *  external on the PSM tier, the stable on the stable pool tier. */
  depositAh: bigint;
  underlyingPeople: bigint;
}

export interface FundingTargets {
  /** What the settle claims (base units); the pipeline must land ≥ this on People. */
  settleAmount: bigint;
  /** The deposit the conversion needs RIGHT NOW, its own fees included: the conversion gate. On
   *  the pool tier the plain quote for settle+buffer plus keepNativeForFees, no headroom; on the
   *  PSM tier the mint that pays out settle+buffer and the XCM's fees, plus the dispatch fee in
   *  the external; on the stable pool tier the plain two-hop quote plus the same fees. */
  depositNeeded: bigint;
}

/** Pure next-step decision from observed balances. */
export function decideStep(b: FundingBalances, t: FundingTargets): FundingStep {
  if (b.underlyingPeople >= t.settleAmount) return "done";
  if (b.depositAh >= t.depositNeeded) return "swap";
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

/** The native budget the rail must deliver for `settleAmount` to be claimable on the pool tier:
 *  the pool quote for settle+buffer plus the headroom (DEFAULT_SLIPPAGE_PCT), plus the native
 *  the funding program spends on its own fees. The single source of truth for app-side budget
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

/** Fresh exact-out quote on the stable/native pool: the stable that buys `nativeOut` right now.
 *  `stablePool.underlying` is the stable. */
export async function quoteStableIn(
  api: AssetHubApi,
  stablePool: Pool,
  nativeOut: bigint,
): Promise<bigint> {
  const quoted = await api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
    stablePool.underlying,
    stablePool.native,
    nativeOut,
    true,
  );
  if (quoted === undefined) {
    throw new Error("stable pool cannot quote this amount: insufficient liquidity");
  }
  return quoted;
}

/** Fresh exact-in quote on the stable/native pool: the native `stableIn` buys right now, or null
 *  when the pool cannot price that much, as `quoteUnderlyingOut` answers. */
export async function quoteNativeOut(
  api: AssetHubApi,
  stablePool: Pool,
  stableIn: bigint,
): Promise<bigint | null> {
  const quoted = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    stablePool.underlying,
    stablePool.native,
    stableIn,
    true,
  );
  return quoted === undefined ? null : quoted;
}

/** The plain two-hop exact-out quote: the native that buys `underlyingOut`, and the stable that
 *  buys that native. No headroom: the stable pool tier's gate compares the deposit against it. */
export async function quoteStableForUnderlying(
  api: AssetHubApi,
  pool: Pool,
  stablePool: Pool,
  underlyingOut: bigint,
): Promise<{ nativeIn: bigint; stableIn: bigint }> {
  const nativeIn = await quoteNativeIn(api, pool, underlyingOut);
  const stableIn = await quoteStableIn(api, stablePool, nativeIn);
  return { nativeIn, stableIn };
}

/** The stable the burner must hold so `stableIn` reaches the first exchange: the min_balance that
 *  stays on the burner and one cushion over every fee, asked for and not held back, as
 *  `psmDepositNeeded` does. */
export function stableDepositNeeded(
  stableIn: bigint,
  fees: Pick<
    StableLegFees,
    "dispatchExternal" | "localExternal" | "deliveryExternal" | "minBalanceExternal"
  >,
): bigint {
  return (
    stableIn +
    fees.minBalanceExternal +
    withFeeMargin(fees.dispatchExternal + fees.localExternal + fees.deliveryExternal)
  );
}

/** Cross-tick memory for one conversion. The driver persists it between ticks; `tickOnce`
 *  mutates it in place. */
export interface TickState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** PSM refusals of the mint so far, at the dry run or at inclusion; MAX_PSM_REFUSALS hold the
   *  run. A transport error or a timeout does not count. */
  psmRefusals: number;
  /** Set once the program landed; holds the run in await-arrival. */
  xcmSubmitted: boolean;
  /** People balance when the XCM left; arrival = growth above this. */
  peopleAtXcm: bigint;
  /** When the first tick saw funds (ms); null while the deposit is still awaited. */
  fundsSeenAt: number | null;
}

export const freshTickState = (): TickState => ({
  attempts: 0,
  psmRefusals: 0,
  xcmSubmitted: false,
  peopleAtXcm: 0n,
  fundsSeenAt: null,
});

export interface TickOnceInput {
  api: AssetHubApi;
  /** People's api, for the dry run of the forwarded program before the submit. */
  peopleApi: PeopleApi;
  /** The tier the request was quoted, as recorded on it (recordedRoute); never decided here. */
  route: ConversionRoute;
  /** The native/CASH pool keys; discovered once and passed in. The pool tiers only. */
  pool?: Pool;
  /** The stable/native pool keys, `underlying` being the stable; discovered once and passed in.
   *  The stable pool tier only. */
  stablePool?: Pool;
  /** The burner, passed as address and signer. */
  address: string;
  signer: PolkadotSigner;
  beneficiaryHex: string;
  settleAmount: bigint;
  peopleParaId: number;
  assetHubParaId: number;
  remoteFeeBuffer: bigint;
  /** Native pool tier only; the stable tiers price their fees live in the stable. */
  keepNativeForFees: bigint;
  /** Pool tiers only. On the stable pool tier it also bounds the first exchange's floor. */
  slippagePct: number;
  /** PSM and stable pool tiers: the deposit the buyer was asked for, frozen at quote time. The
   *  gate checks for exactly this rather than re-pricing the fees, since re-pricing moves the bar
   *  under a deposit that was already sized against it. Absent on a request quoted before it was
   *  recorded, which falls back to the live figure. */
  quotedDeposit?: bigint;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  /** Extra options merged into the signAndSubmit this tick makes, after the PSM tier's fee
   *  asset. */
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

/** The burner's deposit on Asset Hub in the asset the route expects: the native's free balance,
 *  or the holding of the pallet-assets id the route's token names. */
async function readDeposit(api: AssetHubApi, route: ConversionRoute, address: string) {
  const token = depositTokenOf(route);
  if (token.assetHubId === undefined) {
    const account = await api.query.System.Account.getValue(address);
    return account?.data.free ?? 0n;
  }
  const held = await api.query.Assets.Account.getValue(token.assetHubId, address);
  return held?.balance ?? 0n;
}

/**
 * One reading of the balances and at most one action on them. Retryable by calling again;
 * the only terminal signals are the returned "done" and a thrown FundingShortfallError or
 * FundingHeldError.
 */
export async function tickOnce(input: TickOnceInput, state: TickState): Promise<TickOutcome> {
  const { api, route, address } = input;
  const buyAmount = input.settleAmount + input.remoteFeeBuffer;
  const [depositAh, underlyingPeople] = await bounded(
    Promise.all([readDeposit(api, route, address), input.readUnderlyingOnPeople(address)]),
    input.tickTimeoutMs,
    "tick balance reads",
  );
  const balances: FundingBalances = { depositAh, underlyingPeople };

  if (
    state.xcmSubmitted &&
    balances.underlyingPeople > state.peopleAtXcm &&
    balances.underlyingPeople < input.settleAmount
  ) {
    // The transfer arrived yet the target is missed: the destination fee ate past the buffer.
    throw new FundingShortfallError(balances.underlyingPeople, input.settleAmount);
  }

  // Only the convert-vs-await-native decision needs the pool price or the PSM batch's fees.
  const needsGate = !state.xcmSubmitted && balances.underlyingPeople < input.settleAmount;
  // The gate asks whether what arrived buys the target right now; it does not bound the spend.
  // Net of what People already holds, so a run resumed after a partial arrival does not demand
  // the whole deposit a second time.
  const buyNow = buyAmount > balances.underlyingPeople ? buyAmount - balances.underlyingPeople : 0n;
  const earmark = destinationEarmark(buyNow, input.remoteFeeBuffer);
  let depositNeeded = 0n;
  let nativeNeeded = 0n;
  let psmFees: PsmBatchFees | null = null;
  let stableIn = 0n;
  let stableFees: StableLegFees | null = null;
  if (needsGate && isStablePoolRoute(route)) {
    // The plain two-hop quote first, as the native pool tier's gate is plain; a deposit short of
    // even the bare swap waits without the fee reads.
    const pool = poolOf(input);
    const stablePool = stablePoolOf(input);
    stableIn = (
      await bounded(
        quoteStableForUnderlying(api, pool, stablePool, buyNow),
        input.tickTimeoutMs,
        "stable pool quote",
      )
    ).stableIn;
    if (balances.depositAh < stableIn) {
      depositNeeded = stableIn;
    } else {
      stableFees = await bounded(
        estimateStableProgramFees({
          api,
          stable: route.external,
          stablePool,
          pool,
          beneficiaryHex: input.beneficiaryHex,
          peopleParaId: input.peopleParaId,
          // At the magnitude the program will carry: everything the burner holds.
          depositStable: balances.depositAh,
          minUnderlyingOut: buyNow,
          remoteFeesCash: earmark,
          feeProbeAddress: address,
          dryRunFrom: address,
        }),
        input.tickTimeoutMs,
        "stable program fee estimate",
      );
      // The figure the buyer was asked against, frozen at quote time; the live figure stands in
      // where it is missing or no longer owed whole.
      const frozen = buyNow === buyAmount ? input.quotedDeposit : undefined;
      depositNeeded = frozen ?? stableDepositNeeded(stableIn, stableFees);
    }
  } else if (needsGate && route.tier === "pool") {
    // The PLAIN quote: the deposit was asked with headroom on top, and re-applying it here would
    // demand that headroom twice and strand a deposit on any move.
    nativeNeeded = await bounded(
      quoteNativeIn(api, poolOf(input), buyNow),
      input.tickTimeoutMs,
      "pool quote",
    );
    depositNeeded = nativeNeeded + input.keepNativeForFees;
  } else if (needsGate && route.tier === "psm") {
    // The PSM's rate is fixed, so the gate is arithmetic on the batch's own fees. Those take
    // several reads, and a deposit short of even the bare mint waits without them.
    const floor = sizePsmMint(buyNow, route).externalIn;
    if (balances.depositAh < floor) {
      depositNeeded = floor;
    } else {
      psmFees = await bounded(
        estimatePsmBatchFees({
          api,
          route,
          beneficiaryHex: input.beneficiaryHex,
          peopleParaId: input.peopleParaId,
          // At the magnitude the batch will carry: everything the burner holds.
          depositExternal: balances.depositAh,
          remoteFeesCash: earmark,
          feeProbeAddress: address,
          dryRunFrom: address,
        }),
        input.tickTimeoutMs,
        "psm batch fee estimate",
      );
      // Gate on what the buyer was asked for. Both figures cover the same costs, but the fees in
      // them are priced through the pool, so re-pricing here raises the bar whenever PAS has risen
      // since the quote and leaves a deposit that was exactly right waiting for a reversal. The
      // live figure stands in only for a request quoted before this was recorded, and for one
      // resumed after a partial arrival, where the frozen figure covers more than is still owed.
      const frozen = buyNow === buyAmount ? input.quotedDeposit : undefined;
      depositNeeded = frozen ?? psmDepositNeeded(buyNow, route, psmFees);
    }
  }
  const step = decideStep(balances, { settleAmount: input.settleAmount, depositNeeded });
  // Hold in await-arrival while the submitted XCM has not yet credited People. A stale read right
  // after the submit still shows the native, and without this latch it would be converted twice.
  const effective = state.xcmSubmitted && step !== "done" ? "await-arrival" : step;
  // Funds seen: from here the conversion is on the clock.
  if (state.fundsSeenAt === null && effective !== "await-native") state.fundsSeenAt = input.now();

  if (effective === "done") {
    return { step: "done", balances, submitted: false };
  }

  if (effective === "swap" && isStablePoolRoute(route)) {
    // The gate priced the program this very tick: a deposit past the bare swap always did.
    if (stableFees === null) throw new Error("stable pool tier: the swap step has no fee estimate");
    await swapThroughStablePool(
      input,
      state,
      route,
      balances,
      buyNow,
      earmark,
      stableFees,
      stableIn,
    );
    return { step: effective, balances, submitted: true };
  }

  if (effective === "swap" && route.tier === "psm") {
    // The gate priced the batch this very tick: a deposit past the floor always did.
    if (psmFees === null) throw new Error("psm tier: the swap step has no fee estimate");
    await mintThroughPsm(input, state, route, balances, earmark, psmFees);
    return { step: effective, balances, submitted: true };
  }

  if (effective === "swap") {
    const pool = poolOf(input);
    // Withdraw the whole native balance minus the dispatch fee, pay the XCM's fees in native,
    // exchange the rest inside the holding, and teleport the result to the burner on People.
    const fees = await bounded(
      estimateFundingProgramFees({
        api,
        pool,
        beneficiaryHex: input.beneficiaryHex,
        peopleParaId: input.peopleParaId,
        nativeBalance: balances.depositAh,
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
    let spend = balances.depositAh - fees.dispatchNative - payFeesNative;
    if (spend <= 0n) {
      throw new Error(
        `deposit ${balances.depositAh} cannot cover the funding program's own fees ` +
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
    // Run the program on both chains before paying for it. A program that would fail, trap assets
    // or land short of what People still lacks is not submitted; the next tick re-prices and tries
    // again with nothing spent.
    await bounded(
      dryRunFundingProgram({
        api,
        peopleApi: input.peopleApi,
        execArgs,
        from: address,
        beneficiaryHex: input.beneficiaryHex,
        peopleParaId: input.peopleParaId,
        assetHubParaId: input.assetHubParaId,
        mustLand: input.settleAmount - balances.underlyingPeople,
      }),
      input.tickTimeoutMs,
      "funding program dry run",
    );
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

const poolOf = (input: TickOnceInput): Pool => {
  if (input.pool === undefined) throw new Error("pool tier: the tick was given no pool keys");
  return input.pool;
};

const stablePoolOf = (input: TickOnceInput): Pool => {
  if (input.stablePool === undefined) {
    throw new Error("stable pool tier: the tick was given no stable pool keys");
  }
  return input.stablePool;
};

/** The stable pool tier's swap step: everything the fees leave, through both pools, to the burner
 *  on People, after the dry run of the program. Every failure is the next tick's to retry. */
async function swapThroughStablePool(
  input: TickOnceInput,
  state: TickState,
  route: StablePoolRoute,
  balances: FundingBalances,
  buyNow: bigint,
  remoteFeesCash: bigint,
  fees: StableLegFees,
  stableForTarget: bigint,
): Promise<void> {
  const { api, address } = input;
  const pool = poolOf(input);
  const stablePool = stablePoolOf(input);
  // Convert everything the fees leave, not just enough for the target: the dispatch fee, the
  // min_balance and the fee allowance stay out, as on the PSM tier, and the cushion the deposit
  // was asked with reaches the exchange.
  let spend = balances.depositAh - fees.dispatchExternal - fees.heldBackExternal;
  if (spend <= 0n) {
    throw new Error(
      `deposit ${balances.depositAh} cannot cover the stable program's own fees ` +
        `(dispatch ${fees.dispatchExternal} + held back ${fees.heldBackExternal})`,
    );
  }
  const twoHop = async (stableIn: bigint) => {
    const nativeOut = await bounded(
      quoteNativeOut(api, stablePool, stableIn),
      input.tickTimeoutMs,
      "stable pool quote (whole balance)",
    );
    if (nativeOut === null) return null;
    const cashOut = await bounded(
      quoteUnderlyingOut(api, pool, nativeOut),
      input.tickTimeoutMs,
      "pool quote (whole balance)",
    );
    return cashOut === null ? null : { nativeOut, cashOut };
  };
  let quotes = await twoHop(spend);
  if (quotes === null) {
    // A pool too shallow for the whole deposit: buy the target instead, as the native pool tier
    // does, and the surplus stable stays on the burner, reachable through its secret.
    const target =
      (stableForTarget * BigInt(Math.round((100 + input.slippagePct) * 100))) / 10_000n;
    spend = target < spend ? target : spend;
    input.onTransientError?.(
      new Error(
        `a pool cannot absorb the whole balance in one exchange; buying the target with ${spend} instead`,
      ),
    );
    quotes = await twoHop(spend);
    if (quotes === null) throw new Error("the pools cannot quote even the target amount");
  }
  // The second exchange's floor is the requirement itself, as on the native pool tier: a quote
  // already under it waits for the next tick instead of submitting.
  if (quotes.cashOut < buyNow) {
    throw new Error(
      `pool quote ${quotes.cashOut} for the spend is below the target ${buyNow}; waiting for the price`,
    );
  }
  // The first exchange's floor is its quote less the headroom.
  const minNativeOut =
    (quotes.nativeOut * BigInt(Math.round((100 - input.slippagePct) * 100))) / 10_000n;
  const execArgs = buildStableFundingProgram({
    stablePool,
    pool,
    withdrawStable: spend + fees.feeAllowanceExternal,
    payFeesStable: fees.feeAllowanceExternal,
    minNativeOut,
    minUnderlyingOut: buyNow,
    remoteFeesCash,
    beneficiaryHex: input.beneficiaryHex,
    peopleParaId: input.peopleParaId,
    maxWeight: fees.maxWeight,
  });
  // Both chains run the program before it is paid for; one that would fail, trap assets or land
  // short of what People still lacks is not submitted, and the next tick re-prices.
  await bounded(
    dryRunFundingProgram({
      api,
      peopleApi: input.peopleApi,
      execArgs,
      from: address,
      beneficiaryHex: input.beneficiaryHex,
      peopleParaId: input.peopleParaId,
      assetHubParaId: input.assetHubParaId,
      mustLand: input.settleAmount - balances.underlyingPeople,
    }),
    input.tickTimeoutMs,
    "stable program dry run",
  );
  const tx = api.tx.PolkadotXcm.execute(execArgs);
  await input.onBeforeSubmit?.("swap");
  // Counted before the broadcast, so a submit whose answer is lost is still counted.
  state.attempts += 1;
  const res = await bounded(
    // The dispatch fee is charged in the stable, the one asset the burner holds.
    tx.signAndSubmit(input.signer, { ...stableTxOptions(route.external), ...input.signOptions }),
    input.submitTimeoutMs,
    "stable program submit",
  );
  input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number });
  // A rejected program rolls back whole: the deposit stays in the stable minus the dispatch fee,
  // and the next tick re-prices and retries.
  if (!res.ok) {
    throw new Error(
      `stable program dispatch rejected: ${describeDispatchError(res.dispatchError, execArgs)}`,
    );
  }
  state.xcmSubmitted = true;
  state.peopleAtXcm = balances.underlyingPeople;
}

/** The external the PSM tier asks the buyer for, so `buyNow` CASH reaches People: the mint that
 *  pays out exactly `buyNow`, plus what stays out of the mint, plus the cushion.
 *
 *  The dispatch fee is charged in the external before the mint. The XCM's local execution and
 *  delivery are paid in the external too, from the allowance the mint leaves on the burner beside
 *  the external's min_balance, which keeps the account alive for the program to withdraw from and
 *  refund into. Without the held-back part the mint reaps the account and the program fails at its
 *  first instruction; without the dispatch fee the mint finds the balance short.
 *
 *  The cushion covers every fee at once and is taken here, once. It is asked for but not held
 *  back, so it sits in the mint: a deposit made at this figure still mints the full `buyNow` when
 *  the pool has moved against the dispatch fee by up to the cushion, and mints the surplus as
 *  extra CASH when it has not. */
export function psmDepositNeeded(
  buyNow: bigint,
  route: PsmRoute,
  fees: Pick<
    PsmBatchFees,
    "dispatchExternal" | "localExternal" | "deliveryExternal" | "minBalanceExternal"
  >,
): bigint {
  return (
    sizePsmMint(buyNow, route).externalIn +
    fees.minBalanceExternal +
    withFeeMargin(fees.dispatchExternal + fees.localExternal + fees.deliveryExternal)
  );
}

/** The PSM tier's swap step: mint everything the dispatch fee leaves and teleport the CASH to the
 *  burner on People, in one batch, after the dry run of the whole batch. Counts the PSM's
 *  refusals towards the hold; every other failure is the next tick's to retry. */
async function mintThroughPsm(
  input: TickOnceInput,
  state: TickState,
  route: PsmRoute,
  balances: FundingBalances,
  remoteFeesCash: bigint,
  fees: PsmBatchFees,
): Promise<void> {
  const { api, address } = input;
  const refused = (dispatchError: unknown) => {
    const kind = psmRefusalKind(dispatchError);
    if (kind === null) return;
    // Nothing to wait for, so hold on the first one rather than spending a retry budget on a
    // question whose answer cannot change.
    if (kind === "will-not-serve") {
      throw new FundingHeldError(describeDispatchError(dispatchError), kind);
    }
    state.psmRefusals += 1;
    if (state.psmRefusals >= MAX_PSM_REFUSALS) {
      throw new FundingHeldError(describeDispatchError(dispatchError));
    }
  };
  // Mint everything the dispatch fee and the held-back external leave, not just enough for the
  // target; the gate already saw that this pays out the target.
  const externalIn = balances.depositAh - fees.dispatchExternal - fees.heldBackExternal;
  const { batch, execArgs } = buildPsmBatch(api, {
    route,
    externalIn,
    cashMinted: psmMintOut(externalIn, route.feeRate),
    feeAllowanceExternal: fees.feeAllowanceExternal,
    remoteFeesCash,
    beneficiaryHex: input.beneficiaryHex,
    peopleParaId: input.peopleParaId,
    maxWeight: fees.maxWeight,
  });
  // The whole batch on both chains before paying for it, the mint included: a PSM refusal
  // surfaces here, with nothing spent, rather than at inclusion.
  try {
    await bounded(
      dryRunPsmBatch({
        api,
        peopleApi: input.peopleApi,
        batch: { batch, execArgs },
        from: address,
        beneficiaryHex: input.beneficiaryHex,
        peopleParaId: input.peopleParaId,
        assetHubParaId: input.assetHubParaId,
        mustLand: input.settleAmount - balances.underlyingPeople,
      }),
      input.tickTimeoutMs,
      "psm batch dry run",
    );
  } catch (error) {
    if (error instanceof ProgramRejectedError) refused(error.dispatchError);
    throw error;
  }
  await input.onBeforeSubmit?.("swap");
  // Counted before the broadcast, so a submit whose answer is lost is still counted.
  state.attempts += 1;
  const res = await bounded(
    // The dispatch fee is charged in the external, the one asset the burner holds.
    batch.signAndSubmit(input.signer, {
      ...psmBatchTxOptions(route.external),
      ...input.signOptions,
    }),
    input.submitTimeoutMs,
    "psm batch submit",
  );
  input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number });
  // A rejected batch rolls back whole, the mint included: the deposit stays in the external
  // minus the dispatch fee, and the next tick re-prices and retries.
  if (!res.ok) {
    refused(res.dispatchError);
    throw new Error(
      `psm batch dispatch rejected: ${describeDispatchError(res.dispatchError, execArgs)}`,
    );
  }
  state.xcmSubmitted = true;
  state.peopleAtXcm = balances.underlyingPeople;
}
