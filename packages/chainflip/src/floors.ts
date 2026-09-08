// Which sources can serve a purchase of a given size. Floors are learned from Chainflip once
// and every later amount is answered locally.

import type { SourceId } from "@getsome/core";
import {
  DEFAULT_EGRESS,
  pickRegularQuote,
  SLIPPAGE_BUFFER_PCT,
  type EgressConfig,
  type QuoteBackend,
} from "./quote";
import { ChainflipRequestError } from "./sdk";
import { formatSourceAmount, type SourceConfig } from "./sources";

/** Chainflip's per-asset minimums, keyed chain -> asset symbol, in the asset's base units. */
export type MinimumSwapAmounts = Readonly<Record<string, Readonly<Record<string, bigint>>>>;

export interface LimitsBackend {
  getSwapLimits(): Promise<{ minimumSwapAmounts: MinimumSwapAmounts }>;
}

export type FloorsBackend = QuoteBackend & LimitsBackend;

/** A source's learned floor. */
export interface SourceFloor {
  readonly sourceId: SourceId;
  /** Chainflip's minimum swap for this asset, in the asset's base units. */
  readonly minimumBaseUnits: bigint;
  /** What the minimum buys, in egress base units: the smallest purchase this source serves. */
  readonly minimumEgressBaseUnits: bigint;
  /** Chainflip's own duration estimate for a swap of this asset, seconds; null when absent. */
  readonly etaSeconds: number | null;
}

export type SourceFloorResult =
  | { readonly kind: "floor"; readonly floor: SourceFloor }
  /** Not listed by Chainflip, or the network could not answer. `reason` is for logs. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Learns every source's floor: one limits call, then one quote per source at its own minimum.
 * The first source is quoted alone; a network-level failure there marks every source
 * unavailable without asking the rest. Never throws.
 */
export async function learnFloors(
  backend: FloorsBackend,
  sources: readonly SourceConfig[],
  egress: EgressConfig = DEFAULT_EGRESS,
): Promise<ReadonlyMap<SourceId, SourceFloorResult>> {
  const out = new Map<SourceId, SourceFloorResult>();
  let minimums: MinimumSwapAmounts;
  try {
    ({ minimumSwapAmounts: minimums } = await backend.getSwapLimits());
  } catch (e) {
    const reason = `Chainflip limits unavailable: ${e instanceof Error ? e.message : String(e)}`;
    for (const source of sources) out.set(source.sourceId, { kind: "unavailable", reason });
    return out;
  }
  const [canary, ...rest] = sources;
  if (canary === undefined) return out;
  const first = await learnFloor(backend, canary, minimums, egress);
  out.set(canary.sourceId, first.result);
  if (first.outage) {
    for (const source of rest) out.set(source.sourceId, first.result);
    return out;
  }
  await Promise.all(
    rest.map(async (source) => {
      out.set(source.sourceId, (await learnFloor(backend, source, minimums, egress)).result);
    }),
  );
  return out;
}

async function learnFloor(
  backend: QuoteBackend,
  source: SourceConfig,
  minimums: MinimumSwapAmounts,
  egress: EgressConfig,
): Promise<{ result: SourceFloorResult; outage: boolean }> {
  const minimum = minimums[source.chain]?.[source.asset];
  if (minimum === undefined) {
    return {
      result: {
        kind: "unavailable",
        reason: `Chainflip lists no minimum for ${source.chain} ${source.asset}`,
      },
      outage: false,
    };
  }
  try {
    const { quotes } = await backend.getQuoteV2({
      srcChain: source.chain,
      srcAsset: source.asset,
      destChain: egress.chain,
      destAsset: egress.asset,
      amount: minimum.toString(),
    });
    const quote = pickRegularQuote(quotes);
    const egressAmount = BigInt((quote?.["egressAmount"] as string | undefined) ?? "0");
    if (egressAmount === 0n) {
      return {
        result: { kind: "unavailable", reason: `No ${source.asset} -> ${egress.asset} quote` },
        outage: false,
      };
    }
    const eta = quote?.["estimatedDurationSeconds"];
    return {
      result: {
        kind: "floor",
        floor: {
          sourceId: source.sourceId,
          minimumBaseUnits: minimum,
          minimumEgressBaseUnits: egressAmount,
          etaSeconds: typeof eta === "number" ? eta : null,
        },
      },
      outage: false,
    };
  } catch (e) {
    return {
      result: { kind: "unavailable", reason: e instanceof Error ? e.message : String(e) },
      outage: e instanceof ChainflipRequestError && e.outage,
    };
  }
}

/** One source, for one purchase. */
export interface SourceOffer {
  readonly sourceId: SourceId;
  /** Whether a purchase of this size clears the source's floor. */
  readonly available: boolean;
  /** Indicative send amount in the asset's base units: the floor rate scaled to this purchase,
   *  ceil-rounded and buffered like the precise quote. */
  readonly sendBaseUnits: bigint;
  /** `sendBaseUnits` ready to render, in the asset's own units. */
  readonly sendFormatted: string;
  readonly etaSeconds: number | null;
  /** The smallest purchase this source serves, in egress base units, for "from N" copy. */
  readonly minimumEgressBaseUnits: bigint;
}

/**
 * Answers whether `targetEgressBaseUnits` clears the source's floor and roughly what the buyer
 * would send, from a learned floor and with no request. Availability ignores the slippage buffer.
 */
export function offerFor(
  source: SourceConfig,
  floor: SourceFloor,
  targetEgressBaseUnits: bigint,
  overheadBaseUnits = 0n,
  options?: { maxDecimals?: number },
): SourceOffer {
  const totalNeeded = targetEgressBaseUnits + overheadBaseUnits;
  // rate = minimumEgress / minimum -> send = totalNeeded * minimum / minimumEgress, ceil
  const exact =
    (totalNeeded * floor.minimumBaseUnits + floor.minimumEgressBaseUnits - 1n) /
    floor.minimumEgressBaseUnits;
  // Same buffer as the precise quote.
  const send = (exact * SLIPPAGE_BUFFER_PCT) / 100n;
  return {
    sourceId: source.sourceId,
    available: totalNeeded >= floor.minimumEgressBaseUnits,
    sendBaseUnits: send,
    sendFormatted: formatSourceAmount(source, send, options),
    etaSeconds: floor.etaSeconds,
    minimumEgressBaseUnits: floor.minimumEgressBaseUnits,
  };
}
