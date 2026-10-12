import type { TopUpRecord } from "../requests/model";
import type { FailureDetails, PartFailure } from "./failure";
import type { Fact, PhaseInput } from "./types";

/** The message under the timeline. `delay` marks the route's delay text for the state. */
export interface TimelineMessage {
  readonly text: string;
  readonly delay: boolean;
}

export const normal = (text: string): TimelineMessage => ({ text, delay: false });
export const delay = (text: string): TimelineMessage => ({ text, delay: true });

export interface TimelineText {
  readonly message: TimelineMessage;
  /** The detail line under the message, when the phase has one. */
  readonly detail?: string;
}

/** The state a phase's text depends on. `delayed` is whether the current line shows the delay. */
export interface TextState {
  readonly delayed: boolean;
  readonly now: number;
  /** The locale of dates, the person's own when absent. */
  readonly locale?: string;
}

/** Phases 1 and 2, the provider's own. */
export type ProviderPhaseIndex = 0 | 1;

/** The milestones the provider reports, each with the time it was first reached. */
export type ProviderMilestones = Readonly<Partial<Record<"started" | "accepted" | "sent", Fact>>>;

/** What a top-up route adds to the shared frame: its provider part. */
export interface TimelineRoute {
  milestones(record: TopUpRecord): ProviderMilestones;
  phase(record: TopUpRecord, index: ProviderPhaseIndex): PhaseInput;
  /** The expected time `T` of phase 3's Seen part. */
  readonly seenExpectedMs: number;
  /** When our last read of the provider, which moves phases 1 and 2, succeeded. */
  lastReadAt(record: TopUpRecord): number | undefined;
  text(record: TopUpRecord, index: ProviderPhaseIndex, state: TextState): TimelineText;
  /** The failure of a top-up that ended outside the Polkadot part, which words its own. */
  failure(record: TopUpRecord): PartFailure;
  failureDetails(record: TopUpRecord): FailureDetails;
}
