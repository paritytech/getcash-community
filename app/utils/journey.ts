// The journey as five steps: started, payment received, payment processed, converted to CASH,
// added to the balance. Their wording, and the dates beside them.

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
