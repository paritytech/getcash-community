/**
 * The app's debug log: `devLog(tag, message, data?, level?)`.
 *
 * Every line goes two places:
 *
 *  - the console, as ONE string (the Desktop host's console relay prints a
 *    bare object as `[object Object]`, so data is stringified here);
 *  - every registered sink. Sentry's breadcrumb sink is one
 *    (lib/telemetry/breadcrumbs.ts), so the lines that led up to a failure
 *    ride along on its event.
 *
 * A log line is context, never an event: nothing here sends anything. A
 * failure worth counting is a `reportFailure` kind (lib/telemetry).
 *
 * Message and data are scrubbed once, here (telemetry/scrub.ts: no recovery
 * phrase, 32-byte hex value or URL query), for the console and every sink
 * alike. Framework-free: no Vue, no Sentry.
 */
import { safeStringify, scrubText } from "./telemetry/scrub";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** ms epoch */
  time: number;
  level: LogLevel;
  tag: string;
  /** scrubbed */
  message: string;
  /** the payload as scrubbed JSON */
  data?: string;
}

export type LogSink = (entry: LogEntry) => void;

/** a dumped object is cut short rather than flooding the console and the event */
const MAX_DATA_CHARS = 4_000;

const sinks = new Set<LogSink>();

/** Register a sink; returns its remover. */
export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

function toConsole(entry: LogEntry): void {
  const line = `[${entry.tag}] ${entry.message}${entry.data === undefined ? "" : ` ${entry.data}`}`;
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}

export function devLog(
  tag: string,
  message: string,
  data?: unknown,
  level: LogLevel = "info",
): void {
  try {
    const entry: LogEntry = { time: Date.now(), level, tag, message: scrubText(message) };
    if (data !== undefined) {
      const text = scrubText(safeStringify(data));
      entry.data =
        text.length > MAX_DATA_CHARS ? `${text.slice(0, MAX_DATA_CHARS)}…[truncated]` : text;
    }
    toConsole(entry);
    for (const sink of sinks) {
      try {
        sink(entry);
      } catch {
        /* a sink never breaks logging, or the other sinks */
      }
    }
  } catch {
    /* logging never breaks the app */
  }
}
