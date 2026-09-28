// Slippage headroom for a constant-product swap, sized from the pool instead of a fixed percentage.
// The quote already prices our own trade, so the headroom covers only what moves the pool before
// execution: the fee taken from the trade, competing flow and the market move.

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
 * How many typical trades may land ahead of ours in each exposure window. A multiple of a typical
 * trade, not a share of the pool, so the percentage shrinks as the pool deepens.
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
 * On a fiat rail the DOT/USD move cancels (a fixed fiat amount buys fewer DOT that each buy more
 * CASH), so this drift is what remains.
 */
const BAND_SHIFT_PCT = 1.25;

/**
 * The market move each exposure has to survive, in percent. Added to the counted flow, not compared
 * with it, and it does not shrink with depth.
 *
 *   instant: 150% a year over 13 blocks at 4 sigma, since a failed sale traps the withdrawal.
 *   minutes: 80% a year over 30 minutes at 2.5 sigma, since a failed deposit only waits.
 *   hours: the band drift, since the market move cancels on a card purchase.
 *   days: the band drift plus EUR and GBP against the dollar, 8% a year over 3 days at 2.5 sigma.
 */
export const MARKET_MOVE_PCT: Record<Exposure, number> = {
  instant: marketMovePct({ sigmaPerYear: 1.5, windowSeconds: 13 * 6, z: 4 }),
  minutes: marketMovePct({ sigmaPerYear: 0.8, windowSeconds: 30 * 60, z: 2.5 }),
  hours: BAND_SHIFT_PCT,
  days: BAND_SHIFT_PCT + marketMovePct({ sigmaPerYear: 0.08, windowSeconds: 3 * 86_400, z: 2.5 }),
};

/** The least headroom for a pool we do not control, in percent. */
export const EXTERNAL_POOL_FLOOR_PCT = 2;

/** Call sites encode the percentage in basis points, so less than half a step rounds to zero. */
export const SLIPPAGE_STEP_PCT = 0.01;

/** The most we ever allow. A pool that needs more is treated as unavailable for this trade. */
export const MAX_SLIPPAGE_PCT = 10;

/** The pallet's default LP fee, in parts per million, when `AssetConversion.LPFee` is not read. */
export const DEFAULT_LP_FEE_PPM = 3_000n;

const PPM = 1_000_000n;

/**
 * Round up to the next step. The epsilon absorbs float noise such as 7.000000000000001, and
 * dividing instead of multiplying by the step keeps 4.77 from becoming 4.7700000000000005.
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
 * us, on the pallet's curve. Null when either trade cannot clear.
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
 * units, found by bisection.
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
  /** The fee taken out of the trade, in percent of it. It does not shrink with depth. */
  feePct: number;
  /** One competing trade landing first: the part a deeper pool reduces. */
  competitionPct: number;
  /** Half a step: anything below it rounds to zero. */
  quantisationPct: number;
  /** The pallet's rounding of one unit, as a share of the trade. */
  unitPct: number;
  /** The result, rounded up to the step. */
  pct: number;
}

export interface DerivedFloorInput {
  reserves: OrientedReserves;
  /** The exact amount of the out asset the trade wants. */
  tradeOut: bigint;
  /** Taken out of the trade before the bound is checked, in out asset units. */
  feeTakenFromTrade?: bigint;
  /** The one competing trade the bound always has to survive, in out asset units. */
  competingTrade?: bigint;
  feePpm?: bigint;
}

/**
 * The least headroom this trade needs on this pool, before any policy. The fee and the competing
 * trade add up, since the fee is taken whatever the price does.
 */
export function derivedFloorPct(input: DerivedFloorInput): FloorTerms {
  const feePpm = input.feePpm ?? DEFAULT_LP_FEE_PPM;
  const quote = amountIn(input.tradeOut, input.reserves, feePpm);

  // A pool that cannot price the trade reads as the cap.
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

  // A competing trade the pool cannot clear next to ours counts as the cap, not as zero.
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
 * The off-ramp's bound: `safetyPct` is the exchange floor in the XCM, `promisePct` the "receive at
 * least" shown to the seller. Equal on purpose: a promise the chain does not enforce can break.
 */
export interface WithdrawalBounds {
  safetyPct: number;
  promisePct: number;
  /** True when the bound shipped after the ceiling does not cover siblings, market move and fee. */
  overCapacity: boolean;
}

/**
 * How many typical 100 CASH sales by other users the off-ramp bound survives landing ahead of it.
 * Really a volume (about 2,400 CASH), and a team judgement rather than a measurement.
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
  // Rounded down to the step, so overCapacity is judged on the value the encoder ships.
  const ceiling =
    input.ceilingPct !== undefined && Number.isFinite(input.ceilingPct)
      ? floorToStep(input.ceilingPct)
      : undefined;
  const safety = ceiling !== undefined && ceiling < decision.pct ? ceiling : decision.pct;

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
  reserves: OrientedReserves;
  /** The exact amount of the out asset this trade wants. */
  tradeOut: bigint;
  exposure: Exposure;
  /** `AssetConversion.LPFee` read from the chain. Falls back to the pallet default. */
  feePpm?: bigint;
  /** Override the policy: how many reference trades may land first. */
  adverseFlowMultiple?: number;
  /** Override the market move, in percent; see MARKET_MOVE_PCT. */
  marketMovePct?: number;
  /** The least value to return, in percent, before the cap. No floor when unset. */
  floorPct?: number;
  /** See `DerivedFloorInput`. */
  feeTakenFromTrade?: bigint;
  /** See `DerivedFloorInput`. */
  competingTrade?: bigint;
  /** A typical trade on this pool, in out asset units; the flow is a multiple of it. Defaults to
   *  our own trade. */
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
  // Anything that is not a positive number counts as zero, so NaN cannot reach BigInt() or pct.
  const askedMultiple = input.adverseFlowMultiple ?? ADVERSE_FLOW_MULTIPLE[input.exposure];
  const multiple = Number.isFinite(askedMultiple) && askedMultiple > 0 ? askedMultiple : 0;
  const askedMarket = input.marketMovePct ?? MARKET_MOVE_PCT[input.exposure];
  const market = Number.isFinite(askedMarket) && askedMarket > 0 ? askedMarket : 0;
  const policyFloor =
    input.floorPct !== undefined && Number.isFinite(input.floorPct) && input.floorPct > 0
      ? input.floorPct
      : 0;

  // A pool that cannot supply the trade is capped, never floored, so it reads as unavailable.
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

  // `multiple` reference trades, clipped to the room next to ours. No room at all is the cap.
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

  // At least one step of movement, so a deep pool cannot leave only the fee. The fee and the market
  // move are added, since they are independent of each other and of the flow.
  const movement = Math.max(policyMove, floor.competitionPct, SLIPPAGE_STEP_PCT);
  const costs = floor.feePct + movement + market;
  const wanted = Math.max(floor.quantisationPct, floor.unitPct, costs, policyFloor);
  return {
    // Rounded up, since the encoder rounds to the nearest step and could ship one step tighter.
    pct: Math.min(MAX_SLIPPAGE_PCT, ceilToStep(wanted)),
    cappedOut: costs >= MAX_SLIPPAGE_PCT,
    floor,
    marketPct: market,
  };
}
