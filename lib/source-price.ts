// What the buyer sends for this purchase, priced by Chainflip. Display only: no deposit channel
// is opened here.

import type { SourceId } from "@getsome/core";
import {
  computeQuote,
  SOURCE_CONFIG_BY_ID,
  SourceMinimumNotMetError,
  type QuoteBackend,
} from "@getsome/chainflip";
import { mainnetSdk } from "./chainflip-backend";

export interface SourcePrice {
  /** Ready to render, e.g. "0.00042", in the source asset's own units. */
  formatted: string;
  /** The same figure in the asset's base units. */
  baseUnits: bigint;
  /** Chainflip's own estimate for the whole swap, when it offers one. */
  etaSeconds?: number;
}

/** This purchase is under Chainflip's floor for the asset. */
export interface SourceMinimum {
  /** The floor, in the source asset's units, ready to render. */
  minimumFormatted: string;
  assetSymbol: string;
  /** The floor and what this purchase needed, in the asset's base units. */
  minimumBaseUnits: bigint;
  neededBaseUnits: bigint;
  /** `neededBaseUnits` ready to render. */
  neededFormatted: string;
}

export type SourcePriceResult =
  /** Set by the caller while a price is being asked for. */
  | { kind: "pending" }
  | { kind: "price"; price: SourcePrice }
  | { kind: "minimum"; minimum: SourceMinimum }
  | { kind: "unavailable"; reason: string };

/** Ceiling on the wait for a price. */
const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Prices `targetNativeBase` (DOT plancks this purchase needs) in `sourceId`'s asset. Never
 * throws: every failure, including a timeout, comes back as a result.
 */
export async function priceSourceLeg(args: {
  sourceId: SourceId;
  targetNativeBase: bigint;
  backend?: QuoteBackend;
  timeoutMs?: number;
}): Promise<SourcePriceResult> {
  const source = SOURCE_CONFIG_BY_ID.get(args.sourceId);
  if (!source) return { kind: "unavailable", reason: `no Chainflip source for ${args.sourceId}` };
  // One deadline for the whole call: the SDK build and the quote share it.
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`took longer than ${(args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`)),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ),
  );
  try {
    const backend = await Promise.race([args.backend ?? mainnetSdk(), deadline]);
    // Overhead 0: the native budget already covers this flow's on-chain costs.
    const quote = await Promise.race([
      computeQuote(backend, source, args.targetNativeBase, 0n),
      deadline,
    ]);
    const raw = quote.raw as { estimatedDurationSeconds?: unknown } | null;
    const eta =
      typeof raw?.estimatedDurationSeconds === "number" ? raw.estimatedDurationSeconds : null;
    console.info(
      `[coinage] source price: ${quote.source.formatted} ${source.shortName} for ${args.targetNativeBase} native` +
        (eta === null ? "" : `, eta ${Math.round(eta)}s`),
    );
    return {
      kind: "price",
      price: {
        formatted: quote.source.formatted,
        baseUnits: quote.source.amount,
        ...(eta !== null ? { etaSeconds: eta } : {}),
      },
    };
  } catch (e) {
    if (e instanceof SourceMinimumNotMetError) {
      console.info(
        `[coinage] source price: below the ${e.assetSymbol} floor (${e.minimumFormatted} ${e.assetSymbol}); this purchase needs ${e.neededBaseUnits} base units`,
      );
      return {
        kind: "minimum",
        minimum: {
          minimumFormatted: e.minimumFormatted,
          assetSymbol: e.assetSymbol,
          minimumBaseUnits: e.minimumBaseUnits,
          neededBaseUnits: e.neededBaseUnits === 0n ? 1n : e.neededBaseUnits,
          neededFormatted: e.neededFormatted,
        },
      };
    }
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[coinage] source price unavailable: ${reason}`);
    return { kind: "unavailable", reason };
  }
}
