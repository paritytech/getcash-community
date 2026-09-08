// Reverse-quote: desired output on Asset Hub to display-ready source input, over an injected
// backend.

import type { Quote } from "@getsome/core";
import { BelowMinimumSwapAmountError, type GetQuoteV2Args } from "./sdk";
import { formatSourceAmount, type SourceConfig } from "./sources";

export interface QuoteBackend {
  getQuoteV2(args: GetQuoteV2Args): Promise<{ quotes: unknown[] }>;
}

/** 5% buffer on the source amount, applied as x105n/100n in bigint space. Shared with the
 *  indicative offers. */
export const SLIPPAGE_BUFFER_PCT = 105n;

/** On-chain costs on the DOT route: gas + contract storage ≈ 0.5 DOT conservative. */
export const ON_CHAIN_OVERHEAD_PLANCKS = 5_000_000_000n;

/**
 * What the swap egresses to. Default Assethub/DOT; a stable egress is e.g.
 * { chain: 'Assethub', asset: 'USDT', decimals: 6 }.
 */
export interface EgressConfig {
  readonly chain: string;
  readonly asset: string;
  readonly decimals: number;
}

export const DEFAULT_EGRESS: EgressConfig = Object.freeze({
  chain: "Assethub",
  asset: "DOT",
  decimals: 10,
});

const MAX_PRECISE_ATTEMPTS = 5;

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

/**
 * Quotes the source-asset amount that covers `targetBaseUnits` on the egress chain: a reference
 * quote establishes the rate, the buffered estimate is quoted precisely, and the amount is bumped
 * 1% and re-quoted until the egress covers target plus overhead (at most 5 attempts).
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

  // Step 2: source amount needed for target + on-chain overhead, with slippage buffer
  const totalNeeded = targetBaseUnits + overhead;
  // rate = refOutput / refInput -> srcNeeded = totalNeeded * refInput / refOutput
  const srcNeededExact = (totalNeeded * refInput) / refOutput;
  const srcWithBuffer = (srcNeededExact * SLIPPAGE_BUFFER_PCT) / 100n;

  // Step 3: precise quote; verify egressAmount covers totalNeeded, bump if short
  let currentSrcBaseUnits = srcWithBuffer > 0n ? srcWithBuffer : 1000n;

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
      // Below Chainflip's per-asset floor: report the floor.
      if (
        error instanceof BelowMinimumSwapAmountError &&
        currentSrcBaseUnits < error.minimumBaseUnits
      ) {
        throw new SourceMinimumNotMetError({
          sourceId: source.sourceId,
          assetSymbol: source.shortName,
          minimumBaseUnits: error.minimumBaseUnits,
          minimumFormatted: formatSourceAmount(source, error.minimumBaseUnits.toString()),
          neededBaseUnits: currentSrcBaseUnits,
          neededFormatted: formatSourceAmount(source, currentSrcBaseUnits.toString()),
          cause: error,
        });
      }
      throw error;
    }

    const finalQuote = pickRegularQuote(finalQuotes);
    if (!finalQuote) throw new Error(`No quote for ${amount} ${source.asset} -> ${egress.asset}`);

    const egressAmount = BigInt((finalQuote["egressAmount"] as string | undefined) ?? "0");
    if (egressAmount >= totalNeeded) {
      const ingress = (finalQuote["ingressAmount"] as string | undefined) ?? amount;
      return {
        sourceId: source.sourceId,
        source: {
          amount: BigInt(ingress),
          formatted: formatSourceAmount(source, ingress),
          assetSymbol: source.shortName,
          decimals: source.decimals,
        },
        raw: finalQuote,
      };
    }

    // Short by a small amount; bump source by 1% and retry
    currentSrcBaseUnits = (currentSrcBaseUnits * 101n) / 100n;
  }

  throw new Error(
    `Could not find a ${source.asset} amount that covers the target + fees after ${MAX_PRECISE_ATTEMPTS} attempts`,
  );
}
