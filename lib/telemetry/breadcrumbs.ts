/**
 * The log sink that turns every devLog line into a breadcrumb: its tag as
 * the category, its level, its data as text. Sentry keeps the last 100 on
 * each event, so a failure arrives with the lines that led up to it. A
 * breadcrumb is context, never an event of its own.
 *
 * The line is already scrubbed (lib/log.ts scrubs once for every
 * sink), so nothing here scrubs again.
 */
import * as Sentry from "@sentry/vue";
import type { Breadcrumb } from "@sentry/vue";
import { addLogSink, type LogEntry } from "../log";

const MAX_DATA_CHARS = 2_000;

function breadcrumbFor(entry: LogEntry): Breadcrumb {
  const crumb: Breadcrumb = {
    category: entry.tag,
    level: entry.level === "warn" ? "warning" : entry.level,
    message: entry.message,
    timestamp: entry.time / 1000,
  };
  if (entry.data !== undefined)
    crumb.data = {
      data:
        entry.data.length > MAX_DATA_CHARS
          ? `${entry.data.slice(0, MAX_DATA_CHARS)}…[truncated]`
          : entry.data,
    };
  return crumb;
}

export function installBreadcrumbSink(): () => void {
  return addLogSink((entry) => {
    try {
      Sentry.addBreadcrumb(breadcrumbFor(entry));
    } catch {
      /* never throws */
    }
  });
}
