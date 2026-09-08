// Which sources can serve the purchase on screen: every asset's floor and its worth in DOT,
// learned from Chainflip once per session.

import type { SourceId } from "@getsome/core";
import {
  learnFloors,
  SOURCE_CONFIG_BY_ID,
  type FloorsBackend,
  type SourceConfig,
  type SourceFloorResult,
} from "@getsome/chainflip";
import { mainnetSdk } from "./chainflip-backend";
import { SOURCE_CHAINS, sourceIdFor } from "./config";
import { withTimeout } from "./timeout";

/** The sources the pay flow offers: every UI pair with a Chainflip source behind it. */
export const OFFERED_SOURCE_IDS: readonly SourceId[] = SOURCE_CHAINS.flatMap((chain) =>
  chain.assets.map((asset) => sourceIdFor(chain.chain, asset)),
).filter((id): id is SourceId => id !== undefined);

/** Ceiling on the wait for the floors. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Learns every offered source's floor. Never throws: a slow or unreachable network comes back
 * as every source unavailable, with the reason.
 */
export async function learnSourceFloors(
  args: {
    sourceIds?: readonly SourceId[];
    backend?: FloorsBackend;
    timeoutMs?: number;
  } = {},
): Promise<ReadonlyMap<SourceId, SourceFloorResult>> {
  const sources = (args.sourceIds ?? OFFERED_SOURCE_IDS)
    .map((id) => SOURCE_CONFIG_BY_ID.get(id))
    .filter((s): s is SourceConfig => s !== undefined);
  try {
    // One deadline for the whole call: the SDK build and the questions share it.
    const floors = await withTimeout(
      Promise.resolve(args.backend ?? mainnetSdk()).then((backend) =>
        learnFloors(backend, sources),
      ),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "source floors",
    );
    console.info(`[coinage] source floors: ${describe(floors)}`);
    return floors;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[coinage] source floors unavailable: ${reason}`);
    return new Map(sources.map((s) => [s.sourceId, { kind: "unavailable", reason }]));
  }
}

/** One log line for the catalog: each floor's worth in DOT, or why there is none. A shared
 *  failure reason is said once. */
function describe(floors: ReadonlyMap<SourceId, SourceFloorResult>): string {
  const reasons = new Set(
    [...floors.values()].map((r) => (r.kind === "unavailable" ? r.reason : null)),
  );
  if (floors.size > 1 && reasons.size === 1 && !reasons.has(null)) {
    return `all ${floors.size} sources unavailable: ${[...reasons][0]}`;
  }
  return [...floors]
    .map(([id, result]) =>
      result.kind === "floor"
        ? `${id} from ${(Number(result.floor.minimumEgressBaseUnits) / 1e10).toFixed(2)} DOT`
        : `${id} unavailable (${result.reason})`,
    )
    .join("; ");
}
