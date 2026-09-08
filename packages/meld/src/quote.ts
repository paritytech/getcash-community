// Meld quotes are source-denominated (fiat in, crypto out). The rail's port is reverse, so this
// solves the fiat: probe Meld's rate, then correct until the delivered crypto clears the target.

import type { Quote, ReverseQuoteInput } from "@getsome/core";
import type { MeldClientLike, MeldQuoteEntry } from "./client";
import { formatNative, NATIVE_ASSET, NATIVE_DECIMALS, toNativeUnits } from "./native";

/** The buyer and route context a Meld quote needs beyond the target. Fixed per rail instance. */
export interface MeldQuoteContext {
  readonly country: string;
  readonly fiat: string;
  readonly token: string;
  readonly method: string;
}

/** Carried on Quote.raw to the deposit step and the app: the chosen provider line plus the
 *  context it was quoted in. */
export interface MeldQuoteRaw {
  readonly provider: MeldQuoteEntry;
  readonly context: MeldQuoteContext;
  /** Whole-token native amount targeted on the burner. */
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

/** One forward quote at `sourceAmount` fiat, reduced to the best line. */
async function forwardBest(
  client: MeldClientLike,
  ctx: MeldQuoteContext,
  sourceAmount: string,
): Promise<MeldQuoteEntry> {
  const { quotes } = await client.getQuote({
    country: ctx.country,
    sourceCurrencyCode: ctx.fiat,
    destinationCurrencyCode: ctx.token,
    sourceAmount,
    paymentMethodType: ctx.method,
  });
  if (!quotes || quotes.length === 0) {
    throw new Error(`No Meld provider offers ${ctx.method} for ${ctx.token} in ${ctx.country}`);
  }
  const best = pickBestQuote(quotes);
  if (!best) throw new Error("Meld returned no usable quote line");
  return best;
}

/**
 * Solves the fiat for a target native amount. Returns a core Quote whose `source` is the native
 * delivery and whose `raw` carries the chosen fiat line.
 */
export async function computeMeldQuote(
  client: MeldClientLike,
  ctx: MeldQuoteContext,
  req: ReverseQuoteInput,
): Promise<Quote> {
  const nativeAmount = toNativeUnits(req.target);
  const destinationAmount = formatNative(nativeAmount); // whole-token target, e.g. "19.62"
  const targetTokens = Number(destinationAmount);

  // First guess: the target's own number as fiat. Each probe corrects it in both directions
  // toward the smallest fiat that still clears the target.
  let fiatGuess = Math.max(targetTokens, 1);
  let best = await forwardBest(client, ctx, fiatGuess.toFixed(2));
  // Cheapest line seen that delivers at least the target.
  let cleared: MeldQuoteEntry | null = Number(best.destinationAmount) >= targetTokens ? best : null;
  for (let i = 0; i < MAX_SOLVE_ITERATIONS; i++) {
    const out = Number(best.destinationAmount);
    const paid = Number(best.sourceAmount);
    if (out <= 0 || paid <= 0) {
      // No ratio to correct from. Keep a clearing line if there is one; otherwise refuse.
      if (cleared === null) {
        throw new Error(
          `Meld returned an unusable quote (${paid} ${ctx.fiat} for ${out} ${ctx.token}). Try again or another payment method.`,
        );
      }
      break;
    }
    // Clears the target within the buffer's overshoot.
    if (out >= targetTokens && out <= targetTokens * SOLVE_BUFFER) break;
    // Scale fiat by the target/out ratio (down on overshoot, up on undershoot), plus the buffer.
    fiatGuess = paid * (targetTokens / out) * SOLVE_BUFFER;
    let probe: MeldQuoteEntry;
    try {
      probe = await forwardBest(client, ctx, fiatGuess.toFixed(2));
    } catch (e) {
      // The correction fell outside the provider's limits. Keep the cheapest clearing line if
      // there is one; otherwise surface the upstream error.
      if (cleared === null) throw e;
      break;
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
      `Meld could not price ${destinationAmount} ${NATIVE_ASSET} in ${ctx.fiat}; the rate moved on every attempt. Please try again.`,
    );
  }
  best = cleared;

  const raw: MeldQuoteRaw = { provider: best, context: ctx, destinationAmount };
  return {
    sourceId: req.sourceId,
    source: {
      amount: nativeAmount,
      formatted: destinationAmount,
      assetSymbol: NATIVE_ASSET,
      decimals: NATIVE_DECIMALS,
    },
    raw,
  };
}
