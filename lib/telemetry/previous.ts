/**
 * THE PREVIOUS PAGE LOAD, REPORTED BY THIS ONE (session-record.ts classifies
 * it), so a kill that cut a journey is seen even though the page that
 * suffered it could send nothing.
 *
 * An ending that CUT A JOURNEY (killed in the background or the foreground
 * with one open, say mid top-up) is a `previous-session-end` warning:
 * `failure.kind` `unclean-exit`, tags `previous.end`, `previous.session_id`,
 * `previous.release` and `previous.journeys` (each `<journey>:<step>`), and
 * the log that page persisted.
 *
 * Only a cut journey makes an event: iOS can freeze a page and later reclaim
 * it without a single event, and a swipe-away may leave the same "visible,
 * not closed" record, so an ending with nothing open says nothing reliable.
 */
import * as Sentry from "@sentry/vue";
import type { Attachment } from "./session-log";
import type { PreviousSession } from "./session-record";

export function reportPreviousSession(previous: PreviousSession, log: Attachment | null): void {
  try {
    const record = previous.record;
    if (!record) return;
    const unclosed =
      previous.exit === "crash-or-kill-foreground" || previous.exit === "killed-background";
    const journeys = (record.journeys ?? []).map(
      (journey) => `${journey.name}:${journey.lastStep}`,
    );
    if (!unclosed || journeys.length === 0) return;
    Sentry.withScope((scope) => {
      scope.setTags({
        "previous.end": previous.exit,
        "previous.session_id": record.sessionId,
        "previous.screen": record.screen || "none",
        "previous.release": record.release || "unknown",
        "previous.journeys": journeys.join(","),
        "failure.kind": "unclean-exit",
        "failure.reason": previous.exit,
        "journey.expected": "false",
      });
      scope.setContext("previous.session", {
        session_id: record.sessionId,
        gap_ms: previous.gapMs ?? -1,
        ran_ms: Math.max(0, record.lastSeenAt - (record.startedAt ?? record.lastSeenAt)),
        open_journeys: journeys.join(","),
      });
      if (log) scope.addAttachment(log);
      Sentry.captureEvent({
        message: "previous-session-end",
        level: "warning",
        fingerprint: ["previous-session-end", previous.exit],
      });
    });
  } catch {
    /* a diagnostic never breaks the open */
  }
}
