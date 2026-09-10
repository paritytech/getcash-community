// The journey as five steps: started, payment received, payment processed, converted to CASH,
// added to the balance. Maps the session and pipeline state onto how many are done.

import type { FundingStep } from "@getsome/funding";

export interface JourneyInput {
  phase: string | null;
  fundingStep: FundingStep | null;
  /** The swap rail's own progress, meaningful only while the phase is "swapping". */
  swap?: string | null;
  /** The failure kind, meaningful only while the phase is "failed". */
  failure?: { kind: string } | null;
}

/**
 * How many steps are done, 1..5; "started" always counts.
 */
export function journeyDone(input: JourneyInput): number {
  switch (input.phase) {
    case "done":
      return 5;
    case "funded":
    case "working":
      return 4;
    case "failed":
      return failedAt(input);
    case "swapping":
      if (input.swap === "receiving") return 1;
      if (input.swap === "complete") return 3;
      return 2;
    case "awaiting-deposit":
      return fromPipeline(input.fundingStep);
    default:
      return 1;
  }
}

/** What the pool pipeline's last step says is done. */
function fromPipeline(step: FundingStep | null): number {
  switch (step) {
    case "done":
      return 4;
    case "swap":
    case "xcm":
    case "await-arrival":
      return 3;
    default:
      return 1;
  }
}

/** Where a failed request stopped: the pipeline's last step when it ran, else the leg the
 *  failure kind names. */
function failedAt(input: JourneyInput): number {
  const pipeline = fromPipeline(input.fundingStep);
  if (pipeline > 1) return pipeline;
  switch (input.failure?.kind) {
    case "mint":
    case "under-credit":
      return 4; // the claim: everything before it landed
    case "egress-failed":
    case "fallback-egress":
    case "refunded":
    case "refund-failed":
      return 2; // the swap network took the payment but could not deliver
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

/** "Today at 12:45" for a same-day moment, else "May 6 at 5:53 PM". */
export function formatWhenShort(ms: number, locale?: string, now = Date.now()): string {
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );
  const moment = new Date(ms);
  const today = new Date(now);
  const sameDay =
    moment.getFullYear() === today.getFullYear() &&
    moment.getMonth() === today.getMonth() &&
    moment.getDate() === today.getDate();
  if (sameDay) return `Today at ${time}`;
  const date = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(moment);
  return `${date} at ${time}`;
}
