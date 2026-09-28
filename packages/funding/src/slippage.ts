// Slippage headroom for a constant-product swap, computed from the pool instead of a fixed 5%.
//
// The quote already includes the price impact of our own trade, so the headroom only has to cover
// what moves the price between quoting and executing. The answer is built from four things:
//
//   1. The floor (`derivedFloorPct`): fees taken out of the trade, one competing trade, and the
//      rounding of the encoding. This is what the pool and the trade need regardless of policy.
//   2. Counted flow (`ADVERSE_FLOW_MULTIPLE`, `DEFAULT_CONCURRENCY`): how many typical trades may
//      land ahead of ours. This part shrinks as the pool gets deeper.
//   3. The market move (`MARKET_MOVE_PCT`): a pool that arbitrage keeps in line with DOT/USD moves
//      by the market's percentage at any depth, so this part does not shrink.
//   4. A policy floor for the whole thing (`EXTERNAL_POOL_FLOOR_PCT` at the call sites).
//
// `slippageFor` adds the fee, the larger of the counted flow and the one competing trade, and the
// market move, then raises the sum to the policy floor.
//
// Reserves are passed as { in, out } from the caller's side: `in` is what we pay, `out` is what we
// receive. A buy and a sale differ only in which way round they are passed.

/** Reserves oriented the way the caller trades: `in` is paid, `out` is received. */
export interface OrientedReserves {
  in: bigint;
  out: bigint;
}

/** How long a quote has to survive before it executes. */
export type Exposure =
  /** Sized and submitted in the same tick: the off-ramp sale and the fee swap. */
  | "instant"
  /** A direct crypto deposit, usually sent within minutes of the quote. */
  | "minutes"
  /** A card purchase through a fiat provider. */
  | "hours"
  /** A bank transfer through a fiat provider, up to a few days. */
  | "days";

/**
 * How many typical trades may land ahead of ours during each exposure window.
 *
 * It is a multiple of a typical trade and not a share of the pool on purpose: other users trade
 * the same amounts whether the pool holds 100k or 2.5M, so the tolerated flow stays about the same
 * in CASH and the percentage falls as the pool deepens. A share of the pool would give the same
 * percentage at every depth. Longer windows allow more trades, so the table only goes up.
 *
 * These are estimates of how many of our own requests are in flight at once. The measurement
 * worth taking in production is the delay between quote and conversion per request.
 */
export const ADVERSE_FLOW_MULTIPLE: Record<Exposure, number> = {
  instant: 6,
  minutes: 12,
  hours: 20,
  days: 32,
};

const YEAR_SECONDS = 365 * 24 * 3600;

/** A market move described by volatility, time window and how far into the tail to go. */
export interface MarketMoveAssumption {
  /** Yearly volatility of the price the pool follows, as a fraction (0.8 means 80% a year). */
  sigmaPerYear: number;
  /** How long the quote is exposed, in seconds. */
  windowSeconds: number;
  /** How many standard deviations of that move to cover. */
  z: number;
}

/** `z` standard deviations of a `sigmaPerYear` market over `windowSeconds`, in percent. */
export function marketMovePct(m: MarketMoveAssumption): number {
  if (!(m.sigmaPerYear > 0) || !(m.windowSeconds > 0) || !(m.z > 0)) return 0;
  return m.z * m.sigmaPerYear * Math.sqrt(m.windowSeconds / YEAR_SECONDS) * 100;
}

/**
 * How far an arbitraged pool can drift from the market inside its no-arbitrage band, in percent.
 *
 * On a fiat rail the DOT/USD move itself cancels: the provider buys DOT with a fixed fiat amount, so
 * a higher price delivers less DOT and each DOT then buys more CASH. What is left is the pool's
 * offset from the market. With the 1% the Meld solve already over-delivers by, 1.25% gave no stalls
 * at a 1.1% band in simulation, where the counted flow alone stalled up to 14% of card purchases on
 * a 2.5M pool.
 */
const BAND_SHIFT_PCT = 1.25;

/**
 * The market move each exposure has to survive, in percent. It is added to the counted flow, not
 * compared with it, because the market moves the pool whether or not anyone else is trading.
 *
 * The tails follow what a failure costs at each site:
 *
 *   instant: a failed off-ramp sale traps the withdrawal on Asset Hub, so this uses stress
 *     volatility (150% a year) over 13 blocks at 4 standard deviations. The sale is sized at the
 *     best head, so the real window is shorter and the rest is margin. Simulated on an arbitraged
 *     pool from 104k to 10M, no cell trapped 0.1% or more; without this term the worst cell trapped
 *     41.9%.
 *   minutes: a failed crypto deposit only waits, so this uses typical volatility (80% a year) over
 *     30 minutes at 2.5 standard deviations. On an arbitraged 2.5M pool that leaves about 0.02% of
 *     deposits waiting out their window at 80% volatility and about 0.6% at 150%. A deposit sent
 *     hours after the quote waits under the gate until the price comes back or the window ends.
 *   hours: the band drift above, since the market move cancels on a card purchase.
 *   days: the band drift plus EUR and GBP against the dollar over three days (8% a year, 2.5
 *     standard deviations). This row is an estimate; nobody has compared delivered amounts with
 *     provider quotes yet. On today's 104k pool it leaves the bank rail just under the cap: a pool
 *     about 2% shallower, or a failed fee probe, refuses the smallest bank purchases on the pool
 *     route, which is the fallback behind the PSM.
 *
 * Today's testnet pool is not arbitraged, so there this term is only margin.
 */
export const MARKET_MOVE_PCT: Record<Exposure, number> = {
  instant: marketMovePct({ sigmaPerYear: 1.5, windowSeconds: 13 * 6, z: 4 }),
  minutes: marketMovePct({ sigmaPerYear: 0.8, windowSeconds: 30 * 60, z: 2.5 }),
  hours: BAND_SHIFT_PCT,
  days: BAND_SHIFT_PCT + marketMovePct({ sigmaPerYear: 0.08, windowSeconds: 3 * 86_400, z: 2.5 }),
};

/**
 * The least headroom for a pool we do not control, in percent. Agreed in the 16 Sep call (keep at
 * least 2% for external liquidity), and it also gives the off-ramp room for bursts from many users
 * on a deep pool, where the derived value alone drops to about 1.2%.
 */
export const EXTERNAL_POOL_FLOOR_PCT = 2;

/**
 * The step the percentage can be expressed in. Every call site encodes it as
 * `BigInt(Math.round((100 ± pct) * 100)) / 10_000n`, so anything below half a step rounds to no
 * headroom at all.
 */
export const SLIPPAGE_STEP_PCT = 0.01;

/** The most we ever allow. A pool that needs more is treated as unavailable for this trade. */
export const MAX_SLIPPAGE_PCT = 10;

/** The pallet's default LP fee in parts per million, used when `AssetConversion.LPFee` is not read. */
export const DEFAULT_LP_FEE_PPM = 3_000n;

const PPM = 1_000_000n;

/**
 * Round up to the next step. The small epsilon stops 0.07 / 0.01 (which is 7.000000000000001) from
 * gaining a whole step, and dividing by 100 instead of multiplying by 0.01 keeps values like 4.77
 * from turning into 4.7700000000000005.
 */
function ceilToStep(pct: number): number {
  const steps = Math.ceil(pct / SLIPPAGE_STEP_PCT - 1e-9);
  return steps / Math.round(1 / SLIPPAGE_STEP_PCT);
}

/** Round down to the step, for values that act as a ceiling. */
function floorToStep(pct: number): number {
  const steps = Math.floor(pct / SLIPPAGE_STEP_PCT + 1e-9);
  return steps / Math.round(1 / SLIPPAGE_STEP_PCT);
}

/** The pallet's `get_amount_in`: what an exact `out` costs, rounded up by one as the pallet does.
 *  Null when the pool cannot supply that much. */
export function amountIn(
  out: bigint,
  reserves: OrientedReserves,
  feePpm: bigint = DEFAULT_LP_FEE_PPM,
): bigint | null {
  if (reserves.in <= 0n || reserves.out <= 0n) return null;
  if (out <= 0n || out >= reserves.out) return null;
  return (reserves.in * out * PPM) / ((reserves.out - out) * (PPM - feePpm)) + 1n;
}

/** The pallet's `get_amount_out`: what an exact `in` buys. */
export function amountOut(
  input: bigint,
  reserves: OrientedReserves,
  feePpm: bigint = DEFAULT_LP_FEE_PPM,
): bigint | null {
  if (reserves.in <= 0n || reserves.out <= 0n || input <= 0n) return null;
  const withFee = input * (PPM - feePpm);
  return (withFee * reserves.out) / (reserves.in * PPM + withFee);
}

/** The reserves after someone else takes `flowOut` of the out asset first. Null when that trade
 *  cannot clear the pool. */
function afterAdverseFlow(
  reserves: OrientedReserves,
  flowOut: bigint,
  feePpm: bigint,
): OrientedReserves | null {
  const paid = amountIn(flowOut, reserves, feePpm);
  if (paid === null) return null;
  return { in: reserves.in + paid, out: reserves.out - flowOut };
}

/**
 * How much more our exact-out trade costs, in percent, after `flowOut` has moved the pool against
 * us. Computed on the pallet's curve rather than with the 2 x flow / reserve approximation, which
 * is too low once the flow is more than a few percent of the pool. Null when either trade cannot
 * clear.
 */
export function adverseMovePct(
  tradeOut: bigint,
  reserves: OrientedReserves,
  flowOut: bigint,
  feePpm: bigint = DEFAULT_LP_FEE_PPM,
): number | null {
  const before = amountIn(tradeOut, reserves, feePpm);
  if (before === null) return null;
  const moved = afterAdverseFlow(reserves, flowOut, feePpm);
  if (moved === null) return null;
  const after = amountIn(tradeOut, moved, feePpm);
  if (after === null) return null;
  return (Number(after) / Number(before) - 1) * 100;
}

/**
 * The inverse of `adverseMovePct`: the largest competing flow a headroom survives, in out asset
 * units. Useful for reading a percentage: on the 104k pool 5% absorbs about 2.5k CASH, on a 2.5M
 * pool about 60k. Found by bisection, since the move grows with the flow.
 */
export function absorbableFlow(
  tradeOut: bigint,
  reserves: OrientedReserves,
  headroomPct: number,
  feePpm: bigint = DEFAULT_LP_FEE_PPM,
): bigint {
  if (headroomPct <= 0) return 0n;
  let lo = 0n;
  let hi = reserves.out - tradeOut - 1n;
  if (hi <= 0n) return 0n;
  for (let i = 0; i < 64 && lo < hi; i += 1) {
    const mid = lo + (hi - lo + 1n) / 2n;
    const move = adverseMovePct(tradeOut, reserves, mid, feePpm);
    if (move !== null && move <= headroomPct) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** The parts of the floor, so a decision can be explained. */
export interface FloorTerms {
  /** A fee taken out of the trade before the bound is checked. It does not shrink with depth, which
   *  is why small trades stay the expensive case on a deep pool. */
  feePct: number;
  /** One competing trade landing first. This is the part a deeper pool reduces. */
  competitionPct: number;
  /** Half a step: anything below it rounds to zero. */
  quantisationPct: number;
  /** The pallet's rounding of one unit, as a share of the trade. */
  unitPct: number;
  /** The result, rounded up to the step. */
  pct: number;
}

export interface DerivedFloorInput {
  /** Reserves oriented the way the caller trades. */
  reserves: OrientedReserves;
  /** The exact amount of the out asset the trade wants. */
  tradeOut: bigint;
  /** Anything taken out of the trade before the bound is checked, in out asset units, such as the
   *  destination fee on the off-ramp sale. */
  feeTakenFromTrade?: bigint;
  /** The one competing trade the bound always has to survive, in out asset units. */
  competingTrade?: bigint;
  feePpm?: bigint;
}

/**
 * The least headroom this trade needs on this pool, before any policy. The fee and the competing
 * trade add up, since the fee is taken whatever the price does; taking the larger of the two once
 * left a small withdrawal with no room for movement at all. Rounding and the pallet's unit act as
 * minimums instead.
 */
export function derivedFloorPct(input: DerivedFloorInput): FloorTerms {
  const feePpm = input.feePpm ?? DEFAULT_LP_FEE_PPM;
  const quote = amountIn(input.tradeOut, input.reserves, feePpm);

  // A pool that cannot price the trade has no floor to speak of; callers read the cap instead.
  if (quote === null || quote <= 0n) {
    return {
      feePct: MAX_SLIPPAGE_PCT,
      competitionPct: MAX_SLIPPAGE_PCT,
      quantisationPct: SLIPPAGE_STEP_PCT / 2,
      unitPct: 0,
      pct: MAX_SLIPPAGE_PCT,
    };
  }

  const fee = input.feeTakenFromTrade ?? 0n;
  const feePct = fee <= 0n ? 0 : (Number(fee) / Number(input.tradeOut)) * 100;

  // A competing trade the pool cannot clear next to ours means the pool cannot carry this trade,
  // so it counts as the cap, not as zero.
  const competing = input.competingTrade ?? 0n;
  const competitionPct =
    competing <= 0n
      ? 0
      : (adverseMovePct(input.tradeOut, input.reserves, competing, feePpm) ?? MAX_SLIPPAGE_PCT);

  const quantisationPct = SLIPPAGE_STEP_PCT / 2;
  const unitPct = (1 / Number(quote)) * 100;
  const pct = ceilToStep(Math.max(feePct + competitionPct, quantisationPct, unitPct));
  return {
    feePct,
    competitionPct,
    quantisationPct,
    unitPct,
    pct: Math.min(MAX_SLIPPAGE_PCT, pct),
  };
}

/**
 * The off-ramp's bound. `safetyPct` goes into the XCM as the exchange floor, and `promisePct` is
 * the "receive at least" shown to the seller. They are the same number on purpose: a minimum that
 * the chain does not enforce can be missed, and a tighter promise than the floor was broken in 22%
 * of a simulated mixed queue.
 */
export interface WithdrawalBounds {
  safetyPct: number;
  promisePct: number;
  /**
   * The bound that ships does not cover what it is sized for (the siblings, the market move and
   * the fee together), either because the pool asked for more than the cap or because the caller's
   * ceiling cut it. Judged against the value that ships, after the ceiling.
   */
  overCapacity: boolean;
}

/**
 * How many typical withdrawals (100 CASH at the call site) the off-ramp bound survives landing
 * between its quote and its execution. It is really a volume, about 2,400 CASH of one-way sales,
 * so one 3,000 CASH sale uses all of it. These sales come from other users; one worker rarely puts
 * more than one of its own ahead, because each tick waits for People finality. The market move is
 * covered separately by `MARKET_MOVE_PCT`.
 *
 * A failure here traps the withdrawal, while a wider bound only lowers the guaranteed minimum (the
 * sale still fills at the market price). This number is a judgement for the team, not a
 * measurement: 32 would keep 160k at 5% and 2.5M at the 2% floor.
 */
export const DEFAULT_CONCURRENCY = 24;

export function withdrawalBounds(input: {
  reserves: OrientedReserves;
  /** What the sale is expected to return, in out asset units. */
  tradeOut: bigint;
  /** Taken out of the trade before the bound is checked: the Asset Hub execution fee. */
  feeTakenFromTrade?: bigint;
  /** A typical sibling sale, in out asset units. Defaults to this trade. */
  referenceTrade?: bigint;
  /** How many siblings may land first; see DEFAULT_CONCURRENCY. */
  concurrency?: number;
  /** The market move to survive, in percent; defaults to MARKET_MOVE_PCT.instant. */
  marketMovePct?: number;
  /** The least bound to ship, in percent; defaults to EXTERNAL_POOL_FLOOR_PCT. */
  floorPct?: number;
  /** The most the caller will ship, in percent. `overCapacity` is judged after this cut. */
  ceilingPct?: number;
  feePpm?: bigint;
}): WithdrawalBounds {
  // A whole number of siblings: BigInt() below throws on a fraction.
  const asked = input.concurrency ?? DEFAULT_CONCURRENCY;
  const concurrency = Number.isFinite(asked) ? Math.max(1, Math.ceil(asked)) : DEFAULT_CONCURRENCY;
  const reference = input.referenceTrade ?? input.tradeOut;
  const feePpm = input.feePpm ?? DEFAULT_LP_FEE_PPM;
  const decision = slippageFor({
    reserves: input.reserves,
    tradeOut: input.tradeOut,
    exposure: "instant",
    referenceTrade: reference,
    competingTrade: reference,
    adverseFlowMultiple: concurrency,
    marketMovePct: input.marketMovePct ?? MARKET_MOVE_PCT.instant,
    floorPct: input.floorPct ?? EXTERNAL_POOL_FLOOR_PCT,
    ...(input.feeTakenFromTrade === undefined
      ? {}
      : { feeTakenFromTrade: input.feeTakenFromTrade }),
    feePpm,
  });
  // The ceiling is rounded down to the step, so the value judged below is the one the encoder ships.
  const ceiling =
    input.ceilingPct !== undefined && Number.isFinite(input.ceilingPct)
      ? floorToStep(input.ceilingPct)
      : undefined;
  const safety = ceiling !== undefined && ceiling < decision.pct ? ceiling : decision.pct;

  // Does the shipped bound survive that many siblings plus the market move plus the fee?
  // `decision.marketPct` is the cleaned value, so a bad override cannot read as covered.
  let overCapacity = decision.cappedOut;
  if (!overCapacity) {
    const move = adverseMovePct(
      input.tradeOut,
      input.reserves,
      reference * BigInt(concurrency),
      feePpm,
    );
    overCapacity = move === null || decision.floor.feePct + move + decision.marketPct > safety;
  }
  return { safetyPct: safety, promisePct: safety, overCapacity };
}

export interface SlippageInput {
  /** Reserves as the caller trades them: `in` is paid, `out` is received. */
  reserves: OrientedReserves;
  /** The exact amount of the out asset this trade wants. */
  tradeOut: bigint;
  /** How long the quote has to survive. */
  exposure: Exposure;
  /** `AssetConversion.LPFee` read from the chain. Falls back to the pallet default. */
  feePpm?: bigint;
  /** Override the policy: how many reference trades may land first. */
  adverseFlowMultiple?: number;
  /** Override the market move, in percent; see MARKET_MOVE_PCT. */
  marketMovePct?: number;
  /** The least value to return, in percent, before the cap. No floor when unset. */
  floorPct?: number;
  /** Passed to `derivedFloorPct`: what is taken out of the trade before the bound is checked. */
  feeTakenFromTrade?: bigint;
  /** Passed to `derivedFloorPct`: the one competing trade the bound always survives. */
  competingTrade?: bigint;
  /**
   * The size of a typical trade on this pool, in out asset units. The flow to survive is a
   * multiple of this, since other people's trades do not grow when ours does. Defaults to our own
   * trade.
   */
  referenceTrade?: bigint;
}

export interface SlippageDecision {
  /** The headroom to use, in percent. */
  pct: number;
  /** The pool cannot carry this trade within MAX_SLIPPAGE_PCT; treat the route as unavailable. */
  cappedOut: boolean;
  /** The floor and its parts. */
  floor: FloorTerms;
  /** The market move that was added, in percent. */
  marketPct: number;
}

/** The headroom this trade needs on this pool, with the parts it was built from. */
export function slippageFor(input: SlippageInput): SlippageDecision {
  const feePpm = input.feePpm ?? DEFAULT_LP_FEE_PPM;
  // Anything that is not a positive number counts as zero: a NaN multiple would throw in BigInt()
  // and a NaN market move would produce a NaN percentage.
  const askedMultiple = input.adverseFlowMultiple ?? ADVERSE_FLOW_MULTIPLE[input.exposure];
  const multiple = Number.isFinite(askedMultiple) && askedMultiple > 0 ? askedMultiple : 0;
  const askedMarket = input.marketMovePct ?? MARKET_MOVE_PCT[input.exposure];
  const market = Number.isFinite(askedMarket) && askedMarket > 0 ? askedMarket : 0;
  const policyFloor =
    input.floorPct !== undefined && Number.isFinite(input.floorPct) && input.floorPct > 0
      ? input.floorPct
      : 0;

  // An empty pool, a dust pool or a trade the pool cannot supply is capped, never floored, so the
  // caller reads it as "do not route here" and not as the safest pool it has seen.
  const unusable =
    input.reserves.in <= 0n ||
    input.reserves.out <= 0n ||
    input.tradeOut <= 0n ||
    amountIn(input.tradeOut, input.reserves, feePpm) === null;
  if (unusable) {
    return {
      pct: MAX_SLIPPAGE_PCT,
      cappedOut: true,
      floor: derivedFloorPct({ reserves: input.reserves, tradeOut: input.tradeOut, feePpm }),
      marketPct: market,
    };
  }

  // The flow to survive: `multiple` trades of the reference size. If that does not fit next to our
  // trade, or leaves no room at all, the pool cannot carry it and the result is the cap.
  const reference = input.referenceTrade ?? input.tradeOut;
  const flow = (reference * BigInt(Math.round(multiple * 1e6))) / 1_000_000n;
  const room = input.reserves.out - input.tradeOut - 1n;
  const move =
    flow <= 0n
      ? 0
      : room > 0n
        ? adverseMovePct(input.tradeOut, input.reserves, flow > room ? room : flow, feePpm)
        : null;
  const policyMove = move === null ? MAX_SLIPPAGE_PCT : move;

  const floor = derivedFloorPct({
    reserves: input.reserves,
    tradeOut: input.tradeOut,
    feePpm,
    ...(input.feeTakenFromTrade === undefined
      ? {}
      : { feeTakenFromTrade: input.feeTakenFromTrade }),
    ...(input.competingTrade === undefined ? {} : { competingTrade: input.competingTrade }),
  });

  // Movement is the larger of the policy and the floor's one competing trade, and never less than
  // one step, so a deep pool cannot round the movement away and leave only the fee. The fee and
  // the market move are added on top: they are independent of each other and of the flow.
  const movement = Math.max(policyMove, floor.competitionPct, SLIPPAGE_STEP_PCT);
  const costs = floor.feePct + movement + market;
  const wanted = Math.max(floor.quantisationPct, floor.unitPct, costs, policyFloor);
  return {
    // Rounded up, because the encoder rounds to the nearest step and would otherwise ship one
    // step tighter than computed.
    pct: Math.min(MAX_SLIPPAGE_PCT, ceilToStep(wanted)),
    cappedOut: costs >= MAX_SLIPPAGE_PCT,
    floor,
    marketPct: market,
  };
}
