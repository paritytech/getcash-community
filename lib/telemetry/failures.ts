/**
 * DELIBERATE FAILURE EVENTS, one fixed kind each (FAILURE_KINDS in
 * catalogue.ts), so repeats group into one issue per kind and reason
 * (fingerprint `[kind, reason]`).
 *
 * EXPECTED failures (the person said no) go out as warnings with
 * `journey.expected: "true"`, and dashboards leave them out of the failure
 * rate. The whole rule is `isExpected` in catalogue.ts. RECOVERED cases (a
 * retry, a reconnect) are not failures at all: the journey is marked sad
 * and no event is sent.
 */
import * as Sentry from "@sentry/vue";
import { isExpected, type FailureKind } from "./catalogue";
import { describeError, maskSafe, maskSafeValues } from "./scrub";

export type { FailureKind };

export interface FailureDetails {
  /** the main reason: a fixed word, the second half of the fingerprint */
  reason: string;
  /** the thrown value, when there is one: sent as the event's exception */
  error?: unknown;
  /** more context, as text (an error message, a step, a count) */
  context?: Record<string, string>;
}

type Markable = {
  set(attrs: Record<string, string>): void;
  trace: { traceId: string; spanId: string } | null;
};
const unexpected = new WeakSet<object>();

/** `journey.expected` stays "true" only while every failure on it was expected. */
function markExpected(journey: Markable | undefined, expected: boolean): void {
  if (!journey) return;
  if (!expected) unexpected.add(journey);
  journey.set({ "journey.expected": expected && !unexpected.has(journey) ? "true" : "false" });
}

export function sendFailure(kind: FailureKind, details: FailureDetails, journey?: Markable): void {
  const expected = isExpected(kind, details.reason);
  markExpected(journey, expected);
  Sentry.withScope((scope) => {
    scope.setLevel(expected ? "warning" : "error");
    scope.setFingerprint([kind, details.reason]);
    scope.setTags({
      "failure.kind": kind,
      "failure.reason": maskSafe(details.reason),
      "journey.expected": expected ? "true" : "false",
    });
    if (details.context) scope.setContext("failure", maskSafeValues(details.context));
    // a journey runs in a trace of its own: the event belongs beside its spans
    if (journey?.trace)
      scope.setContext("trace", { trace_id: journey.trace.traceId, span_id: journey.trace.spanId });
    if (details.error instanceof Error) {
      Sentry.captureException(details.error);
      return;
    }
    Sentry.captureEvent({
      message: `${kind}: ${details.reason}`,
      ...(details.error !== undefined
        ? { extra: { error: maskSafe(describeError(details.error)) } }
        : {}),
    });
  });
}

export { reasonOf } from "./scrub";
