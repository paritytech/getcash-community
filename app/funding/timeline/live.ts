// The live detail under a timeline's message: shown once the viewer has sat on a step for 3 s,
// on a clock that moves on a 3 s grid although timelines are evaluated every second. A read's
// age is measured from that clock, so it also moves when a fresh read lands between grid ticks.

import { lastReached } from "./model";
import type { TextState } from "./route";
import type { TimelineView } from "./types";

/** How long a step is current before its live detail shows, and how often the detail moves. */
export const LIVE_DETAIL_MS = 3_000;

/**
 * The live clock of a step current since `since`: absent for the first 3 s, then `now` rounded
 * down to the 3 s grid from `since`, so words derived from it change only on a grid tick.
 */
export function liveClock(now: number, since: number): number | undefined {
  const elapsed = now - since;
  if (elapsed < LIVE_DETAIL_MS) return undefined;
  return since + LIVE_DETAIL_MS * Math.floor(elapsed / LIVE_DETAIL_MS);
}

/** When the current step became current: `since` while the view is on the step the previous
 *  view was on, or nothing was shown before, else `now`. A milestone's own time is not enough:
 *  many are facts without one. */
export function stepSince(
  view: TimelineView,
  previous: TimelineView | undefined,
  since: number,
  now: number,
): number {
  return previous === undefined || lastReached(previous) === lastReached(view) ? since : now;
}

/** The live part of a step's text state: its clock, and the read the detail names. */
export function liveState(
  view: TimelineView,
  previous: TimelineView | undefined,
  since: number,
  now: number,
  readAt: number | undefined,
): Pick<TextState, "live" | "readAt"> {
  return { live: liveClock(now, stepSince(view, previous, since, now)), readAt };
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** "just now", "3s ago", "2min ago", "1h ago". */
export function ago(ms: number): string {
  if (ms < SECOND) return "just now";
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s ago`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}min ago`;
  return `${Math.floor(ms / HOUR)}h ago`;
}

/** "`label` 3s ago" for a read at `readAt` on the live clock; absent without either. */
export function checked(
  label: string,
  readAt: number | undefined,
  live: number | undefined,
): string | undefined {
  if (readAt === undefined || live === undefined) return undefined;
  return `${label} ${ago(live - readAt)}`;
}

/** `checked` on a state's own read and clock. */
export const reader =
  ({ live, readAt }: Pick<TextState, "live" | "readAt">) =>
  (label: string): string | undefined =>
    checked(label, readAt, live);

/** The parts of a detail line that are present, joined with a middle dot. */
export function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined);
  return present.length === 0 ? undefined : present.join(" · ");
}

/** `joinDetail`, only once the live clock runs: the stages a step is through are live words. */
export function liveDetail(
  live: number | undefined,
  ...parts: (string | undefined)[]
): string | undefined {
  return live === undefined ? undefined : joinDetail(...parts);
}

/** The step a count is on, `done` of them behind it: "Part 2 of 4", "Confirmation 3 of 3". */
export const stepLine = (label: string, done: number, count: number): string =>
  `${label} ${Math.min(done + 1, count)} of ${count}`;

/** The stages of a step, the first `done` ticked: "Prepared ✓ · Included". */
export function stages(names: readonly string[], done: number): string {
  return names.map((name, index) => (index < done ? `${name} ✓` : name)).join(" · ");
}
