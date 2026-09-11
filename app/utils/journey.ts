// The journey as steps: started, payment received, (card only: payment processed), converted to
// CASH, added to the balance. Maps the session and pipeline state onto how many are done.

import type { FundingStep } from "@getsome/funding";

/** How many steps the route's journey shows: the crypto timeline has no "processed" step. */
export type JourneySteps = 4 | 5;

export interface JourneyInput {
  phase: string | null;
  fundingStep: FundingStep | null;
  /** The swap rail's own progress, meaningful only while the phase is "swapping". */
  swap?: string | null;
  /** The failure kind, meaningful only while the phase is "failed". */
  failure?: { kind: string } | null;
}

/**
 * How many steps are done, 1..steps; "started" always counts. On the crypto scale the swap rail
 * only ever starts after the deposit was detected, so its first report already has the payment
 * step behind it; the card scale keeps "receiving" on the payment step itself.
 */
export function journeyDone(input: JourneyInput, steps: JourneySteps = 5): number {
  switch (input.phase) {
    case "done":
      return steps;
    case "funded":
    case "working":
      return steps - 1;
    case "failed":
      return failedAt(input, steps);
    case "swapping":
      if (input.swap === "receiving") return steps === 4 ? 2 : 1;
      if (input.swap === "complete") return 3;
      return 2;
    case "awaiting-deposit":
      return fromPipeline(input.fundingStep, steps);
    default:
      return 1;
  }
}

/** What the pool pipeline's last step says is done. */
function fromPipeline(step: FundingStep | null, steps: JourneySteps): number {
  switch (step) {
    case "done":
      return steps - 1;
    case "swap":
    case "xcm":
    case "await-arrival":
      return steps - 2;
    default:
      return 1;
  }
}

/** Where a failed request stopped: the pipeline's last step when it ran, else the leg the
 *  failure kind names. */
function failedAt(input: JourneyInput, steps: JourneySteps): number {
  const pipeline = fromPipeline(input.fundingStep, steps);
  if (pipeline > 1) return pipeline;
  switch (input.failure?.kind) {
    case "mint":
    case "under-credit":
      return steps - 1; // the claim: everything before it landed
    case "egress-failed":
    case "fallback-egress":
    case "refunded":
    case "refund-failed":
      // The swap network took the payment but could not deliver: the processed step on the card
      // scale, the payment step itself on the crypto one (the design strikes "Payment").
      return steps - 3;
    case "unknown":
      // The fiat rail could not tell whether the buyer paid; hold at what the pipeline witnessed.
      return pipeline;
    default:
      return 1; // deposit rejected, quote or slot gone stale: nothing past the start
  }
}

export interface StepLabel {
  /** While the step is the one in progress. */
  pending: string;
  /** Once it has landed. */
  done: string;
}

/** The five steps' wording. The received step names what arrived when the asset is known. */
export function journeyLabels(asset: string | null): StepLabel[] {
  return [
    { pending: "Starting your top-up", done: "You started your top-up" },
    {
      pending: "Receiving your payment",
      done: asset ? `We received your ${asset}` : "We received your payment",
    },
    { pending: "Processing your payment", done: "Payment processed" },
    { pending: "Converting to $CASH", done: "Converted to $CASH" },
    { pending: "Adding to your balance", done: "Added to your balance" },
  ];
}

/** "Tuesday, May 6 at 5:53 PM", in the person's own locale unless one is given. */
export function formatWhen(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today at 12:45", "Yesterday at 12:45", else "May 6 at 5:53 PM" — the list's own date line. */
export function formatWhenShort(ms: number, locale?: string, now = Date.now()): string {
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );
  const moment = new Date(ms);
  const today = new Date(now);
  if (sameCalendarDay(moment, today)) return `Today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameCalendarDay(moment, yesterday)) return `Yesterday at ${time}`;
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(moment);
  return `${date} at ${time}`;
}
