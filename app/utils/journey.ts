// The dates and references the journeys show.

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

/** The words for today and yesterday, as they start a line or follow other words. */
type RelativeDays = readonly [today: string, yesterday: string];

function formatWhenRelative(
  ms: number,
  locale: string | undefined,
  now: number,
  [todayWord, yesterdayWord]: RelativeDays,
): string {
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );
  const moment = new Date(ms);
  const today = new Date(now);
  if (sameCalendarDay(moment, today)) return `${todayWord} at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameCalendarDay(moment, yesterday)) return `${yesterdayWord} at ${time}`;
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(moment);
  return `${date} at ${time}`;
}

/** "Today at 12:45", "Yesterday at 12:45", else "May 6 at 5:53 PM": the list's own date line. */
export function formatWhenShort(ms: number, locale?: string, now = Date.now()): string {
  return formatWhenRelative(ms, locale, now, ["Today", "Yesterday"]);
}

/** "today at 12:45", "yesterday at 12:45", else "May 6 at 5:53 PM", to follow other words. */
export function formatWhenInline(ms: number, locale?: string, now = Date.now()): string {
  return formatWhenRelative(ms, locale, now, ["today", "yesterday"]);
}

/**
 * A long reference shown as its ends: "a1f9c3d2-7b44-4e10-9f21-00ab9e4c2e11" -> "a1f9-4c2e".
 *
 * Separators are dropped before slicing, so the abbreviation reads the same whether or not the id
 * is hyphenated. Anything already short enough to show in full is returned untouched — shortening
 * a reference that fits would only make it harder to compare by eye. The full text goes on the
 * clipboard, which is what the reader actually quotes to support.
 */
export function shortRef(reference: string): string {
  const bare = reference.replace(/-/g, "");
  return bare.length <= 9 ? reference : `${bare.slice(0, 4)}-${bare.slice(-4)}`;
}
