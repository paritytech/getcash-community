/**
 * A journey's handle as the app holds it, and the no-op one a build without
 * telemetry gets. Sentry-free, so the doorway can hand it out without
 * loading the core (journeys.ts makes the live one).
 */
import type { JOURNEYS, JourneyName } from "./catalogue";

export type { JourneyName };
export type OutcomeOf<N extends JourneyName> = (typeof JOURNEYS)[N]["outcomes"][number];
export type StepOf<N extends JourneyName> = (typeof JOURNEYS)[N]["steps"][number];
export type Attrs = Record<string, string>;

export interface Step {
  readonly ended: boolean;
  end(attrs?: Attrs): void;
}

export interface Journey<N extends JourneyName = JourneyName> {
  readonly name: N;
  readonly ended: boolean;
  /** the trace this journey runs in; null for a no-op journey */
  readonly trace: { traceId: string; spanId: string } | null;
  step(name: StepOf<N>, attrs?: Attrs): Step;
  set(attrs: Attrs): void;
  markSad(reason: string): void;
  end(outcome: OutcomeOf<N>, attrs?: Attrs): void;
}

export const NOOP_STEP: Step = { ended: true, end() {} };

export function noopJourney<N extends JourneyName>(name: N): Journey<N> {
  return {
    name,
    ended: true,
    trace: null,
    step: () => NOOP_STEP,
    set() {},
    markSad() {},
    end() {},
  };
}
