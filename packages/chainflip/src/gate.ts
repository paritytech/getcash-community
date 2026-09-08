// Liquidity gate. Verdict cache and in-flight dedup live per gate instance, one per rail.

import type { SourceAvailability, SourceId } from "@getsome/core";
import { computeQuote, DEFAULT_EGRESS, type EgressConfig, type QuoteBackend } from "./quote";
import type { SourceConfig } from "./sources";

/**
 * Depth threshold every source must clear before it renders as a payment option, in whole
 * units of the egress asset.
 */
export const GATE_WHOLE_UNITS = 250n;

export interface LiquidityGate {
  probe(source: SourceConfig): Promise<SourceAvailability>;
}

export function createLiquidityGate(
  backend: QuoteBackend,
  egress: EgressConfig = DEFAULT_EGRESS,
  gateAmountBaseUnits?: bigint,
): LiquidityGate {
  const threshold = gateAmountBaseUnits ?? GATE_WHOLE_UNITS * 10n ** BigInt(egress.decimals);
  const verdicts = new Map<SourceId, SourceAvailability>();
  // Concurrent probes for the same source join the same in-flight check.
  const inflight = new Map<SourceId, Promise<SourceAvailability>>();

  return {
    probe(source: SourceConfig): Promise<SourceAvailability> {
      const cached = verdicts.get(source.sourceId);
      if (cached) return Promise.resolve(cached);
      const pending = inflight.get(source.sourceId);
      if (pending) return pending;

      const promise = (async (): Promise<SourceAvailability> => {
        try {
          await computeQuote(backend, source, threshold, undefined, egress);
          const ok: SourceAvailability = { status: "available" };
          verdicts.set(source.sourceId, ok);
          return ok;
        } catch (err) {
          // Pool too thin, asset not supported, or API error: all render as unavailable.
          const bad: SourceAvailability = {
            status: "unavailable",
            reason: err instanceof Error ? err.message : String(err),
          };
          verdicts.set(source.sourceId, bad);
          return bad;
        } finally {
          inflight.delete(source.sourceId);
        }
      })();
      inflight.set(source.sourceId, promise);
      return promise;
    },
  };
}
