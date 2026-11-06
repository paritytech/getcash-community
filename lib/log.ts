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
 * The console gets the line as written, transaction hashes and explorer
 * links included: it never leaves the device, and a build without telemetry
 * has nothing else. The sinks get it scrubbed, once, here
 * (telemetry/scrub.ts: no recovery phrase, 32-byte hex value or URL query),
 * since a sink's lines can leave the device. Framework-free: no Vue, no
 * Sentry.
 */
import { safeStringify, scrubText } from "./telemetry/scrub";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** ms epoch */
  time: number;
  level: LogLevel;
  tag: string;
  /** scrubbed by the time a sink sees it */
  message: string;
  /** the payload as JSON, scrubbed by the time a sink sees it */
  data?: string;
}

export type LogSink = (entry: LogEntry) => void;

/** a dumped object is cut short rather than flooding the console and the event */
const MAX_DATA_CHARS = 4_000;

const clamp = (text: string): string =>
  text.length > MAX_DATA_CHARS ? `${text.slice(0, MAX_DATA_CHARS)}…[truncated]` : text;

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
    const text = data === undefined ? undefined : safeStringify(data);
    const entry: LogEntry = { time: Date.now(), level, tag, message };
    if (text !== undefined) entry.data = clamp(text);
    toConsole(entry);
    if (sinks.size === 0) return;
    // scrubbed whole, then cut: a value cut in half would slip past the patterns
    const scrubbed: LogEntry = {
      ...entry,
      message: scrubText(message),
      ...(text === undefined ? {} : { data: clamp(scrubText(text)) }),
    };
    for (const sink of sinks) {
      try {
        sink(scrubbed);
      } catch {
        /* a sink never breaks logging, or the other sinks */
      }
    }
  } catch {
    /* logging never breaks the app */
  }
}
