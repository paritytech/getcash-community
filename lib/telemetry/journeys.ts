/**
 * JOURNEYS: the intervals we measure. A journey is a top-level span (op
 * `journey.<name>`); each step is a child span (op `<name>.<step>`), and a
 * step's duration is what dashboards aggregate (p50, p95).
 *
 * EVERY ATTRIBUTE IS TEXT. Sentry stores custom span attributes from the JS
 * SDK string-typed, and a raw number or boolean lands as NULL, so only the
 * built-in `span.duration` aggregates as a number. A new interval is a new
 * step (add it to JOURNEYS in catalogue.ts); a new category is a text
 * attribute.
 *
 * `journey.sad` and `journey.expected` are "false" from the start, so their
 * ratios have a denominator: sad means something went wrong that the person
 * recovered from (a retry, a reconnect), expected means the failure was the
 * person's own "no".
 *
 * Span times come from the wall clock (Date.now()), not the SDK's
 * performance clock, which stops while a phone's page is frozen.
 *
 * Three things a journey does on its own, so no caller has to:
 *
 *  - STUCK. A journey with a `stuckMs` in the catalogue that has been the
 *    app's to move for that long sends one `stuck` failure naming the step it
 *    is in, and is marked `journey.stuck`. Only that time counts: the page
 *    visible, on the monotonic clock (which stops while a phone freezes the
 *    page), and no step open that waits on a person (`waitSteps` in the
 *    catalogue: a host prompt, a login).
 *  - HIDDEN. While the page is hidden every open journey has an `app.hidden`
 *    step, so a slow step can be read next to the time the person was away.
 *  - KILLED. A root span is only sent when it ends. On pagehide every open
 *    journey ends as `interrupted` (init.ts). A page the OS kills runs no
 *    handler, so each open journey also keeps a small record (its name and
 *    step) that session-record.ts writes to storage, and the next open names
 *    it in its `unclean-exit` report (previous.ts).
 *
 * Every call on the handle is wrapped: it never throws, and after `end()` it
 * does nothing.
 */
import * as Sentry from "@sentry/vue";
import type { Span } from "@sentry/vue";
import { JOURNEYS, type JourneyName } from "./catalogue";
import { sendFailure } from "./failures";
import { NOOP_STEP, type Attrs, type Journey, type Step } from "./handle";

/** What a killed page leaves behind of one open journey (session-record.ts). */
export interface OpenJourneyRecord {
  name: string;
  lastStep: string;
}

const safe = (work: () => void) => {
  try {
    work();
  } catch {
    /* never throws */
  }
};

/** The reserved outcome of a journey the page went away in. No journey
 *  declares it: a report reads it as "the app was closed or killed here",
 *  next to `journey.interrupted_step`. */
const INTERRUPTED_OUTCOME = "interrupted";

interface Live {
  record: OpenJourneyRecord;
  interrupt: () => void;
  hidden: (hidden: boolean) => void;
}

/** every journey that has not ended */
const open = new Set<Live>();
let changed: (() => void) | null = null;
let pageIsHidden = false;

const noteChange = () => safe(() => changed?.());

/** A journey's root span, in a trace of its own. */
function rootSpan(name: JourneyName, attrs: Attrs): Span {
  return Sentry.startNewTrace(() =>
    Sentry.withActiveSpan(null, () =>
      Sentry.startInactiveSpan({
        name: `journey.${name}`,
        op: `journey.${name}`,
        attributes: attrs,
        startTime: Date.now(),
      }),
    ),
  );
}

/** End every still-open journey as interrupted, so its root is sent while
 *  the page can still send it. Returns how many there were. */
export function interruptOpenJourneys(): number {
  const pending = [...open];
  for (const live of pending) safe(live.interrupt);
  return pending.length;
}

/** The page turned hidden or visible (foreground.ts). */
export function noteJourneysHidden(hidden: boolean): void {
  if (hidden === pageIsHidden) return;
  pageIsHidden = hidden;
  for (const live of [...open]) safe(() => live.hidden(hidden));
}

/** The records of every open journey, for the last-session record. */
export function openJourneyRecords(): OpenJourneyRecord[] {
  return [...open].map(({ record }) => ({ ...record }));
}

/** One listener: the last-session record, rewritten when a journey changes. */
export function setOpenJourneyListener(listener: (() => void) | null): void {
  changed = listener;
}

export function resetJourneysForTests(): void {
  open.clear();
  changed = null;
  pageIsHidden = false;
}

const stuckAfter = (name: JourneyName): number | undefined =>
  (JOURNEYS[name] as { stuckMs?: number }).stuckMs;
const waitStepsOf = (name: JourneyName): readonly string[] =>
  (JOURNEYS[name] as { waitSteps?: readonly string[] }).waitSteps ?? [];
const monotonic = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createJourney<N extends JourneyName>(name: N, attrs: Attrs = {}): Journey<N> {
  const began = Date.now();
  const root = rootSpan(name, { ...attrs, "journey.sad": "false", "journey.expected": "false" });
  const context = root.spanContext();
  const steps = new Set<Step>();
  let ended = false;
  let lastStep = "none";
  let hiddenStep: Span | null = null;
  let stuckTimer: ReturnType<typeof setTimeout> | undefined;
  const record: OpenJourneyRecord = { name, lastStep };

  const finish = (outcome: string, more?: Attrs) => {
    if (ended) return;
    ended = true;
    clearTimeout(stuckTimer);
    open.delete(live);
    for (const step of [...steps]) step.end({ "step.outcome": "cut" });
    safe(() => {
      hiddenStep?.end(Date.now());
      hiddenStep = null;
      root.setAttributes({ ...(more ?? {}), "journey.outcome": outcome });
      root.end(Date.now());
    });
    noteChange();
  };

  const startHidden = (hidden: boolean) => {
    if (ended) return;
    syncStuck();
    if (hidden && !hiddenStep) {
      root.setAttributes({ "journey.hidden": "true" });
      hiddenStep = Sentry.startInactiveSpan({
        name: "app.hidden",
        op: `${name}.app.hidden`,
        parentSpan: root,
        attributes: { "hidden.during": lastStep },
        startTime: Date.now(),
      });
    } else if (!hidden && hiddenStep) {
      hiddenStep.end(Date.now());
      hiddenStep = null;
    }
  };

  // THE STUCK CLOCK: only time that is the app's to move counts (see the
  // header). Every pause and resume banks what has run and re-arms the timer
  // for what is left; a timer that fires early (it slept with the page)
  // re-arms too.
  const stuckMs = stuckAfter(name);
  const waitSteps = waitStepsOf(name);
  let activeMs = 0;
  let activeSince: number | null = null;
  let waiting = 0;
  let stuckSent = false;
  const stuckRan = () => activeMs + (activeSince === null ? 0 : monotonic() - activeSince);
  const syncStuck = () => {
    if (!stuckMs || ended || stuckSent) return;
    const active = !pageIsHidden && waiting === 0;
    if (active && activeSince === null) activeSince = monotonic();
    else if (!active && activeSince !== null) {
      activeMs += monotonic() - activeSince;
      activeSince = null;
    }
    clearTimeout(stuckTimer);
    if (activeSince !== null)
      stuckTimer = setTimeout(() => safe(onStuckTimer), Math.max(0, stuckMs - stuckRan()));
  };
  const onStuckTimer = () => {
    if (!stuckMs || ended || stuckSent || activeSince === null) return;
    if (stuckRan() < stuckMs - 50) {
      syncStuck();
      return;
    }
    stuckSent = true;
    root.setAttributes({ "journey.stuck": "true", "journey.stuck_step": lastStep });
    root.setAttributes({ "journey.sad": "true", "journey.sad_reason": "stuck" });
    sendFailure(
      "stuck",
      {
        reason: `${name}.${lastStep}`,
        context: { journey: name, step: lastStep, after_ms: String(Date.now() - began) },
      },
      journey,
    );
  };

  const interrupt = () =>
    // not sad: closing the app is not a failure, and an earlier sad reason stays
    finish(INTERRUPTED_OUTCOME, {
      "journey.interrupted_by": "pagehide",
      "journey.interrupted_step": lastStep,
      "journey.interrupted_after_ms": String(Math.max(0, Date.now() - began)),
    });

  const journey: Journey<N> = {
    name,
    get ended() {
      return ended;
    },
    trace: { traceId: context.traceId, spanId: context.spanId },
    step(stepName, stepAttrs = {}) {
      if (ended) return NOOP_STEP;
      let child: Span;
      try {
        child = Sentry.startInactiveSpan({
          name: stepName,
          op: `${name}.${stepName}`,
          parentSpan: root,
          attributes: stepAttrs,
          startTime: Date.now(),
        });
      } catch {
        return NOOP_STEP;
      }
      lastStep = stepName;
      record.lastStep = stepName;
      const waits = waitSteps.includes(stepName);
      if (waits) {
        waiting += 1;
        syncStuck();
      }
      noteChange();
      let stepEnded = false;
      const step: Step = {
        get ended() {
          return stepEnded;
        },
        end(more) {
          if (stepEnded) return;
          stepEnded = true;
          steps.delete(step);
          if (waits) {
            waiting -= 1;
            syncStuck();
          }
          safe(() => {
            if (more) child.setAttributes(more);
            child.end(Date.now());
          });
          noteChange();
        },
      };
      steps.add(step);
      return step;
    },
    set(more) {
      if (!ended) safe(() => root.setAttributes(more));
    },
    markSad(reason) {
      if (ended) return;
      safe(() => root.setAttributes({ "journey.sad": "true", "journey.sad_reason": reason }));
    },
    end(outcome, more) {
      finish(outcome, more);
    },
  };
  const live: Live = { record, interrupt, hidden: (hidden) => safe(() => startHidden(hidden)) };
  open.add(live);
  if (pageIsHidden) live.hidden(true);
  safe(syncStuck);
  noteChange();
  return journey;
}
