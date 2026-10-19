import type { TopUpRecord } from "../requests/model";
import type { TimelineFailure } from "./failure";
import { timelineView } from "./model";
import { earlierFact } from "./observed";
import {
  depositOnBurner,
  polkadotFailure,
  polkadotMilestones,
  polkadotPhase,
  polkadotPhaseOf,
  polkadotText,
  workerTickAt,
} from "./polkadot";
import {
  delay,
  type ProviderMilestones,
  type ProviderPhaseIndex,
  type TimelineMessage,
  type TimelineRoute,
} from "./route";
import { TOP_UP_TIMELINE } from "./top-up-spec";
import type { TimelineView } from "./types";

export interface TopUpTimeline {
  readonly view: TimelineView;
  /** Absent once the top-up failed or is done. */
  readonly message?: TimelineMessage;
  readonly detail?: string;
  /** Present once the top-up failed. */
  readonly failure?: TimelineFailure;
  /** The provider sent the funds, they are not seen yet, and the reads are fresh. */
  readonly awaitingSentFunds?: boolean;
}

/** A timeline as the journey shows it: before the first milestone, the message alone. */
export type JourneyTimeline = Omit<TopUpTimeline, "view"> & { readonly view?: TimelineView };

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

const isProviderPhase = (index: number): index is ProviderPhaseIndex => index < 2;

/** When the top-up ended short of success, which stops the current line. */
function failedAt({ status }: TopUpRecord): number | undefined {
  return status.kind === "failed" || status.kind === "expired" ? status.at : undefined;
}

/** The provider's milestones, with Sent at the provider's report or the deposit on the burner,
 *  whichever came first: money on the burner shows the provider sent it. */
function providerMilestones(record: TopUpRecord, route: TimelineRoute): ProviderMilestones {
  const milestones = route.milestones(record);
  return { ...milestones, sent: earlierFact(milestones.sent, depositOnBurner(record)) };
}

/** The failure of a top-up whose `failed` milestone is red. */
function failureOf(record: TopUpRecord, route: TimelineRoute, failed: number): TimelineFailure {
  const part = polkadotFailure(record, failed) ?? route.failure(record);
  return { ...part, details: route.failureDetails(record) };
}

/** The timeline of a top-up on its route, never behind the view shown before. Absent until it
 *  opens with the deposit, unless the top-up ended before. */
export function topUpTimeline(
  record: TopUpRecord,
  route: TimelineRoute,
  { now, watchingSince, locale, previous, sentUnseenMs = 0 }: TopUpTimelineOptions,
): TopUpTimeline | undefined {
  const view = timelineView(TOP_UP_TIMELINE, {
    reached: { ...providerMilestones(record, route), ...polkadotMilestones(record) },
    phase: (index) =>
      isProviderPhase(index)
        ? route.phase(record, index)
        : polkadotPhase(record, polkadotPhaseOf(index), {
            seenExpectedMs: route.seenExpectedMs,
            sentUnseenMs,
          }),
    failedAt: failedAt(record),
    now,
    previous,
  });
  if (view === undefined) return undefined;
  if (view.state === "done") return { view };
  if (view.state === "failed") return { view, failure: failureOf(record, route, view.failed) };

  const state = { delayed: view.state === "delayed", now, locale };
  const providerPhase = isProviderPhase(view.phase);
  const text = providerPhase
    ? route.text(record, view.phase, state)
    : polkadotText(record, polkadotPhaseOf(view.phase), state);
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

const HANDOFF_PENDING = delay(
  "This is taking longer than usual. Your top-up will continue automatically.",
);

/** The timeline of a top-up the worker has not taken on yet: the current line shows the delay
 *  and the text says the top-up continues, with or without a milestone reached. */
export function handoffPending(timeline: TopUpTimeline | undefined): JourneyTimeline {
  if (timeline === undefined) return { message: HANDOFF_PENDING };
  const { view } = timeline;
  return {
    view: view.state === "active" ? { ...view, state: "delayed" } : view,
    message: HANDOFF_PENDING,
  };
}
