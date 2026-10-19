// Reverse-quote: desired output on Asset Hub to display-ready source input, over an injected
// backend.

import { TOKENS, type Quote, type TokenSpec } from "@getsome/core";
import { BelowMinimumSwapAmountError, type GetQuoteV2Args } from "./sdk";
import { formatSourceAmount, type SourceConfig } from "./sources";

export interface QuoteBackend {
  getQuoteV2(args: GetQuoteV2Args): Promise<{ quotes: unknown[] }>;
}

/** The fill-or-kill tolerance asked of Chainflip on the channels this app opens, percent, unless
 *  the quote recommends more for its pair. Chainflip's quotes recommend this for the stable pairs
 *  into USDT and for most of DOT out, 1 for stables into DOT, and 1 to 2.5 for BTC, ETH and SOL
 *  in, higher as the swap grows. */
export const CHANNEL_SLIPPAGE_FLOOR_PCT = 0.5;

/** What the worst fill a channel accepts must still deliver over the target, percent: room for
 *  the rounding of Chainflip's minimum price and for its fees moving a little between the quote
 *  and the deposit. */
export const SOURCE_BUFFER_OVER_TOLERANCE_PCT = 0.25;

/** The tolerance a channel opened on `quote` asks for, percent: CHANNEL_SLIPPAGE_FLOOR_PCT, or the
 *  quote's own recommendation when that is higher. */
export function channelSlippagePct(quote: Record<string, unknown> | undefined): number {
  const recommended = Number(quote?.["recommendedSlippageTolerancePercent"]);
  return Number.isFinite(recommended) && recommended > CHANNEL_SLIPPAGE_FLOOR_PCT
    ? recommended
    : CHANNEL_SLIPPAGE_FLOOR_PCT;
}

/** A tolerance in basis points; past 100% a channel accepts any fill. */
function toleranceBps(tolerancePct: number): bigint {
  const bps = BigInt(Math.round(tolerancePct * 100));
  return bps < 10_000n ? bps : 10_000n;
}

const MARGIN_BPS = BigInt(Math.round(SOURCE_BUFFER_OVER_TOLERANCE_PCT * 100));

/** `amount` scaled so that at the same rate the worst fill a channel tolerating `tolerancePct`
 *  accepts still covers `amount`'s worth with SOURCE_BUFFER_OVER_TOLERANCE_PCT to spare, rounded
 *  up. Shared with the indicative offers. */
export function withSourceBuffer(amount: bigint, tolerancePct: number): bigint {
  const kept = 10_000n - toleranceBps(tolerancePct);
  if (kept === 0n) throw new RangeError(`a ${tolerancePct}% tolerance accepts any fill`);
  return (amount * (10_000n + MARGIN_BPS) + kept - 1n) / kept;
}

/** The fee of `type` included in `quote`, in its own asset's base units; 0 when there is none. */
function includedFee(quote: Record<string, unknown>, type: string): bigint {
  const fees = quote["includedFees"];
  if (!Array.isArray(fees)) return 0n;
  const amount = (fees as { type?: unknown; amount?: unknown }[]).find(
    (f) => f.type === type,
  )?.amount;
  if (typeof amount === "bigint") return amount;
  return typeof amount === "string" && /^\d+$/.test(amount) ? BigInt(amount) : 0n;
}

/**
 * What a channel opened on `quote` with `tolerancePct` delivers at the worst fill it accepts, in
 * egress base units. The channel refunds a swap paying less than the quote's estimatedPrice less
 * the tolerance (the SDK's minimum price), and that price is the swap's own output, before the
 * egress fee comes off: so the floor is the egress plus its fee, less the tolerance, less the fee.
 */
export function worstFill(quote: Record<string, unknown>, tolerancePct: number): bigint {
  const egress = BigInt((quote["egressAmount"] as string | undefined) ?? "0");
  const egressFee = includedFee(quote, "EGRESS");
  const worst =
    ((egress + egressFee) * (10_000n - toleranceBps(tolerancePct))) / 10_000n - egressFee;
  return worst > 0n ? worst : 0n;
}

/** How far a resize aims over `required`, basis points of it: the pool's own price impact and the
 *  price moving between quotes leave an amount solved to `required` exactly a hair short. */
const AIM_BPS = 1n;

const aimFor = (required: bigint): bigint => required + (required * AIM_BPS + 9_999n) / 10_000n;

/** How much a covering quote must over-cover, basis points of its amount, before it is tightened:
 *  under this, one more quote is not worth asking for. */
const TIGHTEN_BPS = 5n;

/**
 * The amount whose worst fill reaches a little over `required`, solved from `quote`, for
 * `current`, at that quote's own price with its fixed fees kept fixed. Only what the ingress fee
 * leaves of the deposit swaps, at estimatedPrice before the egress fee comes off, so that amount
 * is the ingress fee plus (aim + egress fee) / (price x (1 - tolerance)). Null when the quote
 * delivers nothing to solve from.
 */
function solvedAmount(
  quote: Record<string, unknown>,
  current: bigint,
  tolerancePct: number,
  required: bigint,
): bigint | null {
  const egress = BigInt((quote["egressAmount"] as string | undefined) ?? "0");
  const ingressFee = includedFee(quote, "INGRESS");
  const egressFee = includedFee(quote, "EGRESS");
  const swapped = current - ingressFee;
  const kept = 10_000n - toleranceBps(tolerancePct);
  if (egress === 0n || swapped <= 0n || kept === 0n) return null;
  const per = (egress + egressFee) * kept;
  return ingressFee + ((aimFor(required) + egressFee) * swapped * 10_000n + per - 1n) / per;
}

/** A quote's amount and the worst fill its channel accepts. */
interface Point {
  amount: bigint;
  worst: bigint;
}

/**
 * The amount between a short quote and a covering one whose worst fill reaches a little over
 * `required`, on the line through the two. Their fees are the same fixed sums, so the line holds
 * them where a single quote's price cannot: Chainflip's network fee, flat under about $500.
 */
function interpolated(short: Point, covering: Point, required: bigint): bigint {
  const span = covering.worst - short.worst;
  const rise = (aimFor(required) - short.worst) * (covering.amount - short.amount);
  return short.amount + (rise + span - 1n) / span;
}

/** The next amount after a quote that fell short: the solved one, at least one unit more, and
 *  twice as much when the quote delivers nothing to solve from. */
function nextAmount(
  quote: Record<string, unknown>,
  current: bigint,
  tolerancePct: number,
  required: bigint,
): bigint {
  const solved = solvedAmount(quote, current, tolerancePct, required);
  if (solved === null) return current * 2n;
  return solved > current ? solved : current + 1n;
}

/** On-chain costs on the DOT route: gas + contract storage ≈ 0.5 DOT conservative. */
export const ON_CHAIN_OVERHEAD_PLANCKS = 5_000_000_000n;

/**
 * What the swap egresses to. Default Assethub/DOT; a stable egress is e.g.
 * `egressFor(TOKENS.USDT)`.
 */
export interface EgressConfig {
  readonly chain: string;
  readonly asset: string;
  readonly decimals: number;
}

/** A token Chainflip can deliver: it must have a Chainflip asset name for the wire. */
export type ChainflipToken = TokenSpec & Required<Pick<TokenSpec, "chainflipAsset">>;

/** The token as Chainflip delivers it; undefined for one it cannot, such as USDC. */
export const chainflipTokenOf = (token: TokenSpec): ChainflipToken | undefined =>
  token.chainflipAsset === undefined ? undefined : (token as ChainflipToken);

/** Chainflip's name for Asset Hub, where every token in the table is delivered. */
const EGRESS_CHAIN = "Assethub";

export function egressFor(token: ChainflipToken): EgressConfig {
  return Object.freeze({
    chain: EGRESS_CHAIN,
    asset: token.chainflipAsset,
    decimals: token.decimals,
  });
}

export const DEFAULT_EGRESS: EgressConfig = egressFor(TOKENS.PAS);

/** Precise quotes before giving up: a guess, the floor when the guess fell under it, a resize, and
 *  room for the recommended tolerance to change with the size and the price to tick between them. */
const MAX_PRECISE_ATTEMPTS = 6;

/**
 * The purchase is smaller than Chainflip will swap for the chosen asset. `neededBaseUnits` is
 * what the purchase asked for, `minimumBaseUnits` is the floor; their ratio scales the target.
 */
export class SourceMinimumNotMetError extends Error {
  readonly sourceId: string;
  readonly assetSymbol: string;
  readonly minimumBaseUnits: bigint;
  readonly minimumFormatted: string;
  readonly neededBaseUnits: bigint;
  /** `neededBaseUnits` ready to render. */
  readonly neededFormatted: string;

  constructor(info: {
    sourceId: string;
    assetSymbol: string;
    minimumBaseUnits: bigint;
    minimumFormatted: string;
    neededBaseUnits: bigint;
    neededFormatted: string;
    cause?: unknown;
  }) {
    super(
      `The smallest ${info.assetSymbol} swap is ${info.minimumFormatted} ${info.assetSymbol}, ` +
        `more than this purchase needs; ask for a larger amount.`,
      info.cause === undefined ? undefined : { cause: info.cause },
    );
    this.name = "SourceMinimumNotMetError";
    this.sourceId = info.sourceId;
    this.assetSymbol = info.assetSymbol;
    this.minimumBaseUnits = info.minimumBaseUnits;
    this.minimumFormatted = info.minimumFormatted;
    this.neededBaseUnits = info.neededBaseUnits;
    this.neededFormatted = info.neededFormatted;
  }
}

export function pickRegularQuote(quotes: unknown[]): Record<string, unknown> | null {
  const regular = (quotes as { type?: string }[]).find((q) => q.type === "REGULAR");
  return (regular ?? quotes[0] ?? null) as Record<string, unknown> | null;
}

/** The purchase is under `error`'s floor, and `needed` is what it asked for. */
function minimumNotMet(
  source: SourceConfig,
  needed: bigint,
  error: BelowMinimumSwapAmountError,
): SourceMinimumNotMetError {
  return new SourceMinimumNotMetError({
    sourceId: source.sourceId,
    assetSymbol: source.shortName,
    minimumBaseUnits: error.minimumBaseUnits,
    minimumFormatted: formatSourceAmount(source, error.minimumBaseUnits.toString()),
    neededBaseUnits: needed,
    neededFormatted: formatSourceAmount(source, needed.toString()),
    cause: error,
  });
}

/**
 * Quotes the source-asset amount that covers `targetBaseUnits` on the egress chain: a reference
 * quote establishes the rate, the buffered estimate is quoted precisely, and the amount is solved
 * again from each short quote's own price and fees and re-quoted until the worst fill its channel
 * accepts covers target plus overhead with SOURCE_BUFFER_OVER_TOLERANCE_PCT to spare (at most
 * MAX_PRECISE_ATTEMPTS quotes).
 */
export async function computeQuote(
  backend: QuoteBackend,
  source: SourceConfig,
  /** Desired egress output, in the egress asset's base units. */
  targetBaseUnits: bigint,
  /** On-chain cost buffer added to the target, in egress base units. Defaults to 0.5 DOT on
   *  the DOT egress and zero elsewhere. */
  overheadBaseUnits?: bigint,
  egress: EgressConfig = DEFAULT_EGRESS,
): Promise<Quote> {
  // The default overhead applies to the Assethub/DOT route only.
  const overhead =
    overheadBaseUnits ??
    (egress.chain === DEFAULT_EGRESS.chain && egress.asset === DEFAULT_EGRESS.asset
      ? ON_CHAIN_OVERHEAD_PLANCKS
      : 0n);
  // Step 1: reference quote to get the rate
  const { quotes: refQuotes } = await backend.getQuoteV2({
    srcChain: source.chain,
    srcAsset: source.asset,
    destChain: egress.chain,
    destAsset: egress.asset,
    amount: source.referenceAmountBaseUnits,
  });

  const refQuote = pickRegularQuote(refQuotes);
  if (!refQuote) throw new Error(`No quote available for ${source.asset} -> ${egress.asset}`);

  const refOutput = BigInt((refQuote["egressAmount"] as string | undefined) ?? "0");
  const refInput = BigInt(source.referenceAmountBaseUnits);
  if (refOutput === 0n) throw new Error("Reference quote returned zero output");

  // Step 2: source amount whose worst fill covers target + on-chain overhead, at the reference rate
  const totalNeeded = targetBaseUnits + overhead;
  const required = totalNeeded + (totalNeeded * MARGIN_BPS + 9_999n) / 10_000n;
  // rate = refOutput / refInput -> srcNeeded = totalNeeded * refInput / refOutput
  const srcNeededExact = (totalNeeded * refInput) / refOutput;
  const srcWithBuffer = withSourceBuffer(srcNeededExact, channelSlippagePct(refQuote));

  // Step 3: precise quote at the purchase's own size, where the fixed fees weigh more and the
  // recommended tolerance may differ; judged by the worst fill its channel accepts, and solved
  // again from its own price and fees until that covers.
  let currentSrcBaseUnits = srcWithBuffer > 0n ? srcWithBuffer : 1000n;
  // Set once a guess fell under Chainflip's floor and the floor itself is being quoted; `needed`
  // stays the first guess, the floor follows Chainflip's latest answer.
  // Typed by assertion: narrowed from its initializer, it would read as null inside the catch.
  let underFloor = null as { needed: bigint; error: BelowMinimumSwapAmountError } | null;
  // A quote that covers with room to spare, kept while a tighter amount is quoted once.
  let covering = null as { quote: Record<string, unknown>; amount: string } | null;
  // The last quote that fell short, which brackets the amount with the first one that covers.
  let lastShort = null as Point | null;

  const accept = (quote: Record<string, unknown>, amount: string): Quote => {
    const ingress = (quote["ingressAmount"] as string | undefined) ?? amount;
    return {
      sourceId: source.sourceId,
      source: {
        amount: BigInt(ingress),
        formatted: formatSourceAmount(source, ingress),
        assetSymbol: source.shortName,
        decimals: source.decimals,
      },
      raw: quote,
    };
  };

  for (let attempt = 0; attempt < MAX_PRECISE_ATTEMPTS; attempt++) {
    const amount = currentSrcBaseUnits.toString();
    let finalQuotes: unknown[];
    try {
      ({ quotes: finalQuotes } = await backend.getQuoteV2({
        srcChain: source.chain,
        srcAsset: source.asset,
        destChain: egress.chain,
        destAsset: egress.asset,
        amount,
      }));
    } catch (error) {
      // The tighter amount is a refinement only: whatever stops it, the covering quote stands.
      if (covering !== null) return accept(covering.quote, covering.amount);
      if (
        !(error instanceof BelowMinimumSwapAmountError) ||
        currentSrcBaseUnits >= error.minimumBaseUnits
      ) {
        throw error;
      }
      // Under Chainflip's per-asset floor, by a guess the reference rate made or because the floor
      // rose meanwhile. Quote the floor itself: only a purchase it covers on its own is too small.
      underFloor = { needed: underFloor?.needed ?? currentSrcBaseUnits, error };
      currentSrcBaseUnits = error.minimumBaseUnits;
      continue;
    }

    const finalQuote = pickRegularQuote(finalQuotes);
    if (!finalQuote) throw new Error(`No quote for ${amount} ${source.asset} -> ${egress.asset}`);

    const tolerancePct = channelSlippagePct(finalQuote);
    const worst = worstFill(finalQuote, tolerancePct);
    if (worst >= required) {
      // The floor covers this purchase with room to spare: report it instead of quietly buying
      // more than was asked for.
      if (underFloor !== null && currentSrcBaseUnits === underFloor.error.minimumBaseUnits) {
        throw minimumNotMet(source, underFloor.needed, underFloor.error);
      }
      // A guess from the reference rate over-covers a purchase whose fixed fees weigh less than
      // they did there, and a resize one whose fixed fees weigh more. Tighten once: between the
      // last short quote and this one when there was one, else from this quote's own price; and
      // take the tighter amount only if it covers too.
      const tighter =
        lastShort === null
          ? solvedAmount(finalQuote, currentSrcBaseUnits, tolerancePct, required)
          : interpolated(lastShort, { amount: currentSrcBaseUnits, worst }, required);
      const roomy = currentSrcBaseUnits - (currentSrcBaseUnits * TIGHTEN_BPS) / 10_000n;
      if (
        covering === null &&
        tighter !== null &&
        tighter < roomy &&
        attempt + 1 < MAX_PRECISE_ATTEMPTS
      ) {
        covering = { quote: finalQuote, amount };
        currentSrcBaseUnits = tighter;
        continue;
      }
      return accept(finalQuote, amount);
    }

    // The tighter amount fell short after all: the covering quote stands.
    if (covering !== null) return accept(covering.quote, covering.amount);
    lastShort = { amount: currentSrcBaseUnits, worst };
    currentSrcBaseUnits = nextAmount(finalQuote, currentSrcBaseUnits, tolerancePct, required);
  }

  throw new Error(
    `Could not find a ${source.asset} amount that covers the target + fees after ${MAX_PRECISE_ATTEMPTS} attempts`,
  );
}
