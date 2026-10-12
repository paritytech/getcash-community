import type { TopUpRecord } from "../requests/model";
import { timelineView } from "./model";
import {
  depositOnBurner,
  polkadotMilestones,
  polkadotPhase,
  polkadotText,
  workerTickAt,
} from "./polkadot";
import type { ProviderPhaseIndex, TimelineMessage, TimelineRoute } from "./route";
import type { PhaseIndex, TimelineView } from "./types";

export interface TopUpTimeline {
  readonly view: TimelineView;
  /** Absent once the top-up failed or is done. */
  readonly message?: TimelineMessage;
  readonly detail?: string;
  /** The provider sent the funds, they are not seen yet, and the reads are fresh. */
  readonly awaitingSentFunds?: boolean;
}

export interface TopUpTimelineOptions {
  readonly now: number;
  /** When the app started watching the top-up. Reads count as missing only from then on. */
  readonly watchingSince: number;
  /** The locale of dates, the person's own when absent. */
  readonly locale?: string;
  /** The view shown before, so that the current line never moves back. */
  readonly previous?: TimelineView;
  /** How long this session's reads were fresh, in total, while the funds the provider sent were
   *  not seen. */
  readonly sentUnseenMs?: number;
}

/** How long the reads that move the current phase may go without success before we say so. */
export const RECONNECT_AFTER_MS = 60_000;

const isProviderPhase = (index: PhaseIndex): index is ProviderPhaseIndex => index < 2;

/** When the top-up ended short of success, which stops the current line. */
function failedAt({ status }: TopUpRecord): number | undefined {
  return status.kind === "failed" || status.kind === "expired" ? status.at : undefined;
}

/** The timeline of a top-up on its route, never behind the view shown before. Absent until it
 *  opens with the deposit, unless the top-up ended before. */
export function topUpTimeline(
  record: TopUpRecord,
  route: TimelineRoute,
  { now, watchingSince, locale, previous, sentUnseenMs = 0 }: TopUpTimelineOptions,
): TopUpTimeline | undefined {
  const view = timelineView({
    reached: { ...route.milestones(record), ...polkadotMilestones(record) },
    phase: (index) =>
      isProviderPhase(index)
        ? route.phase(record, index)
        : polkadotPhase(record, index, { seenExpectedMs: route.seenExpectedMs, sentUnseenMs }),
    failedAt: failedAt(record),
    now,
    previous,
  });
  if (view === undefined) return undefined;
  if (view.state === "done" || view.state === "failed") return { view };

  const state = { delayed: view.state === "delayed", now, locale };
  const providerPhase = isProviderPhase(view.phase);
  const text = providerPhase
    ? route.text(record, view.phase, state)
    : polkadotText(record, view.phase, state);
  const lastReadAt = (providerPhase ? route.lastReadAt(record) : workerTickAt(record)) ?? -Infinity;
  const reconnecting = now - Math.max(lastReadAt, watchingSince) > RECONNECT_AFTER_MS;
  return {
    view,
    message: text.message,
    detail: reconnecting ? "Trying to reconnect" : text.detail,
    ...(view.phase === 2 && !reconnecting && depositOnBurner(record) === undefined
      ? { awaitingSentFunds: true }
      : {}),
  };
}
