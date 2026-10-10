import type { TopUpRecord } from "../requests/model";
import { timelineView } from "./model";
import { polkadotMilestones, polkadotPhase, polkadotText } from "./polkadot";
import type { ProviderPhaseIndex, TimelineMessage, TimelineRoute } from "./route";
import type { PhaseIndex, TimelineView } from "./types";

export interface TopUpTimeline {
  readonly view: TimelineView;
  /** Absent once the top-up failed or is done. */
  readonly message?: TimelineMessage;
  readonly detail?: string;
}

const isProviderPhase = (index: PhaseIndex): index is ProviderPhaseIndex => index < 2;

/** When the top-up ended short of success, which stops the current line. */
function failedAt({ status }: TopUpRecord): number | undefined {
  return status.kind === "failed" || status.kind === "expired" ? status.at : undefined;
}

/** The timeline of a top-up on its route at `now`, never behind the view shown before. */
export function topUpTimeline(
  record: TopUpRecord,
  route: TimelineRoute,
  now: number,
  previous?: TimelineView,
): TopUpTimeline {
  const provider = route.milestones(record);
  const view = timelineView({
    reached: { ...provider, started: provider.started ?? {}, ...polkadotMilestones(record) },
    phase: (index) =>
      isProviderPhase(index)
        ? route.phase(record, index)
        : polkadotPhase(record, index, route.seenExpectedMs),
    failedAt: failedAt(record),
    now,
    previous,
  });
  if (view.state === "done" || view.state === "failed") return { view };

  const state = { delayed: view.state === "delayed", now };
  const text = isProviderPhase(view.phase)
    ? route.text(record, view.phase, state)
    : polkadotText(record, view.phase, state);
  return { view, ...text };
}
