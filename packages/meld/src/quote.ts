// Meld quotes are source-denominated (fiat in, crypto out). The rail's port is reverse, so this
// solves the fiat: probe Meld's rate at an amount it accepts, work out what the target costs at
// that rate, check that against the method's limits, then correct until the delivered crypto
// clears the target.

import type { Quote, ReverseQuoteInput, TokenSpec } from "@getsome/core";
import { fiatLimitOf, type MeldClientLike, type MeldQuoteEntry } from "./client";
import { formatBaseUnits, toBaseUnits, type MeldToken } from "./units";

/** The buyer and route context a Meld quote needs beyond the target. Fixed per rail instance. */
export interface MeldQuoteContext {
  readonly country: string;
  readonly fiat: string;
  /** The token Meld delivers; its `meldCurrencyCode` is the wire destination, and its Chainflip
   *  identifier is what the rail port's SourceDescriptor and Quote name delivered assets by. */
  readonly token: MeldToken & Required<Pick<TokenSpec, "chainflipAsset">>;
  readonly method: string;
  /** The method's fiat limits in `fiat`, from the corridor, when the caller has them. The rate
   *  probe starts at `min`; without one it starts at a guess and learns a bound from a refusal. */
  readonly limits?: { readonly min?: string; readonly max?: string };
}

/**
 * What the target costs falls outside the method's limits. Thrown before a quote is placed at that
 * fiat, so the buyer is told the bound and the cost rather than an upstream refusal.
 */
export class MeldAmountOutOfRangeError extends Error {
  constructor(
    readonly bound: "min" | "max",
    /** The method's limit, decimal text in `fiat`. */
    readonly limit: string,
    /** About what the target costs, decimal text in `fiat`. */
    readonly estimatedFiat: string,
    readonly fiat: string,
  ) {
    super(
      bound === "min"
        ? `Below the minimum: this costs about ${estimatedFiat} ${fiat}, and the minimum is ${limit} ${fiat}.`
        : `Above the maximum: this costs about ${estimatedFiat} ${fiat}, and the maximum is ${limit} ${fiat}.`,
    );
    this.name = "MeldAmountOutOfRangeError";
  }
}

/** A limit's decimal text as a positive number, or undefined. */
function positive(text: string | undefined): number | undefined {
  const n = Number(text);
  return text !== undefined && text !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Carried on Quote.raw to the deposit step and the app: the chosen provider line plus the
 *  context it was quoted in. */
export interface MeldQuoteRaw {
  readonly provider: MeldQuoteEntry;
  readonly context: MeldQuoteContext;
  /** Whole-token amount of `context.token` targeted on the burner. */
  readonly destinationAmount: string;
}

/** The line delivering the most crypto; ties broken by higher customerScore. */
export function pickBestQuote(quotes: readonly MeldQuoteEntry[]): MeldQuoteEntry | null {
  let best: MeldQuoteEntry | null = null;
  for (const q of quotes) {
    if (best === null) {
      best = q;
      continue;
    }
    const more = Number(q.destinationAmount) > Number(best.destinationAmount);
    const tie = Number(q.destinationAmount) === Number(best.destinationAmount);
    if (more || (tie && (q.customerScore ?? 0) > (best.customerScore ?? 0))) best = q;
  }
  return best;
}

/** Correction passes after the first probe. */
const MAX_SOLVE_ITERATIONS = 4;
/** Fiat overshoot factor applied to each correction. */
const SOLVE_BUFFER = 1.01;
/** How close a line's fiat must sit to a bound to count as priced at it (half a cent). */
const BOUND_SLACK = 0.005;

/** One forward quote at `sourceAmount` fiat, reduced to the best line. */
async function forwardBest(
  client: MeldClientLike,
  ctx: MeldQuoteContext,
  sourceAmount: string,
): Promise<MeldQuoteEntry> {
  const { quotes } = await client.getQuote({
    country: ctx.country,
    sourceCurrencyCode: ctx.fiat,
    destinationCurrencyCode: ctx.token.meldCurrencyCode,
    sourceAmount,
    paymentMethodType: ctx.method,
  });
  if (!quotes || quotes.length === 0) {
    throw new Error(
      `No Meld provider offers ${ctx.method} for ${ctx.token.meldCurrencyCode} in ${ctx.country}`,
    );
  }
  const best = pickBestQuote(quotes);
  if (!best) throw new Error("Meld returned no usable quote line");
  return best;
}

/**
 * Solves the fiat for a target amount of the context's token. Returns a core Quote whose `source`
 * is that delivery and whose `raw` carries the chosen fiat line.
 */
export async function computeMeldQuote(
  client: MeldClientLike,
  ctx: MeldQuoteContext,
  req: ReverseQuoteInput,
): Promise<Quote> {
  const tokenAmount = toBaseUnits(ctx.token, req.target);
  const destinationAmount = formatBaseUnits(ctx.token, tokenAmount); // whole-token target, e.g. "19.62"
  const targetTokens = Number(destinationAmount);

  // The method's bounds: the corridor's where the caller had them, else learned from a refusal.
  const bounds = { min: positive(ctx.limits?.min), max: positive(ctx.limits?.max) };

  // The rate probe, at an amount Meld accepts: the method's minimum. A token's own number read as
  // fiat is no rate at all in a currency worth far less than the token (8.9 DOT is not 8.90 INR),
  // so it is only the fallback when no minimum is known, and a refusal on a bound moves the probe
  // to the bound it names, once.
  let best: MeldQuoteEntry;
  try {
    best = await forwardBest(client, ctx, (bounds.min ?? Math.max(targetTokens, 1)).toFixed(2));
  } catch (e) {
    const limit = fiatLimitOf(e);
    if (limit === undefined) throw e;
    bounds[limit.bound] = positive(limit.amount);
    best = await forwardBest(client, ctx, limit.amount);
  }
  // Cheapest line seen that delivers at least the target.
  let cleared: MeldQuoteEntry | null = Number(best.destinationAmount) >= targetTokens ? best : null;
  for (let i = 0; i < MAX_SOLVE_ITERATIONS; i++) {
    const out = Number(best.destinationAmount);
    const paid = Number(best.sourceAmount);
    if (out <= 0 || paid <= 0) {
      // No ratio to correct from. Keep a clearing line if there is one; otherwise refuse.
      if (cleared === null) {
        throw new Error(
          `Meld returned an unusable quote (${paid} ${ctx.fiat} for ${out} ${ctx.token.meldCurrencyCode}). Try again or another payment method.`,
        );
      }
      break;
    }
    // Clears the target within the buffer's overshoot.
    if (out >= targetTokens && out <= targetTokens * SOLVE_BUFFER) break;
    // What the target costs at this line's rate. A line at a bound that still misses the target
    // settles it: out of range is the buyer's answer, not a quote to send. A projection past a
    // bound from elsewhere does not, since a provider's fixed fee bends the line; it moves the
    // probe to the bound.
    const need = paid * (targetTokens / out);
    if (bounds.min !== undefined && need < bounds.min && paid <= bounds.min + BOUND_SLACK) {
      throw new MeldAmountOutOfRangeError("min", bounds.min.toFixed(2), need.toFixed(2), ctx.fiat);
    }
    if (bounds.max !== undefined && need > bounds.max && paid >= bounds.max - BOUND_SLACK) {
      throw new MeldAmountOutOfRangeError("max", bounds.max.toFixed(2), need.toFixed(2), ctx.fiat);
    }
    // Scale fiat by the target/out ratio (down on overshoot, up on undershoot), plus the buffer,
    // held within the bounds.
    const fiatGuess = Math.min(
      Math.max(need * SOLVE_BUFFER, bounds.min ?? 0),
      bounds.max ?? Infinity,
    );
    let probe: MeldQuoteEntry;
    try {
      probe = await forwardBest(client, ctx, fiatGuess.toFixed(2));
    } catch (e) {
      // The correction fell outside the provider's limits. Keep the cheapest clearing line if
      // there is one; otherwise name the bound, or surface the upstream error.
      if (cleared !== null) break;
      const limit = fiatLimitOf(e);
      if (limit === undefined) throw e;
      throw new MeldAmountOutOfRangeError(limit.bound, limit.amount, need.toFixed(2), ctx.fiat);
    }
    best = probe;
    if (
      Number(best.destinationAmount) >= targetTokens &&
      (cleared === null || Number(best.sourceAmount) < Number(cleared.sourceAmount))
    )
      cleared = best;
  }
  // Only a clearing line may be quoted.
  if (cleared === null) {
    throw new Error(
      `Meld could not price ${destinationAmount} ${ctx.token.chainflipAsset} in ${ctx.fiat}; the rate moved on every attempt. Please try again.`,
    );
  }
  best = cleared;

  const raw: MeldQuoteRaw = { provider: best, context: ctx, destinationAmount };
  return {
    sourceId: req.sourceId,
    source: {
      amount: tokenAmount,
      formatted: destinationAmount,
      assetSymbol: ctx.token.chainflipAsset,
      decimals: ctx.token.decimals,
    },
    raw,
  };
}
