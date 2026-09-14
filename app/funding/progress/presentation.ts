import { sharedCashProgress } from "./shared";
import type { FundingProgressProjection } from "./types";

export function formatFundingProgressElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return seconds === 0 ? "just now" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// The shared CASH tail every rail ends with; its last stage is the balance top-up, the rest the
// conversion. Named by key, not position, so a reorder cannot silently remap the journey.
const CASH_KEYS = new Set<string>(sharedCashProgress.stages.map((stage) => stage.key));
const CREDIT_KEY = sharedCashProgress.stages.at(-1)!.key;

/**
 * Which of the journey's five steps (Detecting, Confirming, Processing, Converting, Crediting) is
 * active: an index 0..4, or 5 once settled. Derived from the same progress projection the history
 * list reads, so the timeline can never show a different phase than the list does.
 */
export function journeyTimelineStep(projection: FundingProgressProjection): number {
  const { view } = projection;
  if (view.kind === "settled") return 5;
  // A failure before any payment was detected stops on the first step with nothing complete.
  if (view.kind === "failed" && projection.detectedAt === undefined) return 0;
  const key = view.activeStageKey;
  if (key === CREDIT_KEY) return 4; // crediting CASH
  if (key !== undefined && CASH_KEYS.has(key)) return 3; // converting to CASH
  if (key === undefined) return 0; // no stage confirmed yet: still detecting the payment
  // A route leg. Once the payment is fully received, the next move is the conversion.
  if (projection.routeCompletedAt !== undefined) return 3;
  return view.activeNodeIndex <= 1 ? 1 : 2; // first route leg confirms, later legs process
}
