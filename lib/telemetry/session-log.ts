/**
 * THE SESSION'S LOG, for a failure that needs more than its last 100
 * breadcrumbs: every devLog line of this page load, from its first.
 *
 * The lines are kept in memory, already scrubbed (lib/log.ts), up to
 * MEMORY_LINES. The newest of them, up to PERSIST_LINES and PERSIST_CHARS,
 * are also written to localStorage
 * (at most every PERSIST_EVERY_MS, and at once when the page turns hidden or
 * goes away), so a page the OS kills still leaves its last lines behind for
 * the next open.
 *
 * The log leaves the device only attached to an event:
 *
 *  - the first AUTO_ATTACH unexpected errors of a page load (init.ts);
 *  - the next open's `previous-session-end` when the last page was killed
 *    with a journey open: the lines THAT page persisted (previous.ts).
 *
 * The attachment is `log-<app>-<session>.json`:
 * `{ meta, lines: [{ t, level, tag, message, data? }] }`, cut from its
 * oldest end to MAX_ATTACHMENT_CHARS and scrubbed once more as a whole.
 *
 * The key lives in the page's own localStorage, never host storage: these
 * writes must not turn into host traffic. Never throws.
 */
import type * as Sentry from "@sentry/vue";
import { addLogSink, type LogEntry } from "../log";
import { scrubText } from "./scrub";

/** the SDK keeps its Attachment type to itself: the shape addAttachment takes */
export type Attachment = Parameters<ReturnType<typeof Sentry.getCurrentScope>["addAttachment"]>[0];

const MEMORY_LINES = 3_000;
const PERSIST_LINES = 400;
/** what the persisted copy may take of the app's localStorage, which it shares with the app's own data */
const PERSIST_CHARS = 64_000;
const PERSIST_EVERY_MS = 10_000;
const MAX_ATTACHMENT_CHARS = 400_000;
/** errors of one page load that carry the log; later ones have breadcrumbs */
const AUTO_ATTACH = 3;

interface Line {
  t: number;
  level: string;
  tag: string;
  message: string;
  data?: string;
}

interface Stored {
  sessionId: string;
  release: string;
  savedAt: number;
  lines: Line[];
}

interface Info {
  product: string;
  release: string;
  sessionId: string;
}

const lines: Line[] = [];
let info: Info | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let autoAttached = 0;

const key = (product: string) => `sentry:${product}:log.v1`;

const toLine = (entry: LogEntry): Line => ({
  t: entry.time,
  level: entry.level,
  tag: entry.tag,
  message: entry.message,
  ...(entry.data !== undefined ? { data: entry.data } : {}),
});

function persistNow(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!info || !dirty) return;
  dirty = false;
  const storageKey = key(info.product);
  try {
    // the newest lines that fit the budget
    const kept: Line[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0 && kept.length < PERSIST_LINES; i--) {
      const line = lines[i];
      size += line.message.length + (line.data?.length ?? 0) + 64;
      if (size > PERSIST_CHARS) break;
      kept.unshift(line);
    }
    const stored: Stored = {
      sessionId: info.sessionId,
      release: info.release,
      savedAt: Date.now(),
      lines: kept,
    };
    localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch {
    // full storage: give the room back to the app's own data
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* blocked storage: the memory copy still serves this page */
    }
  }
}

/** Start keeping this page's lines; returns the remover. Read the stored
 *  log of the previous page (`persistedLog`) BEFORE this overwrites it. */
export function installSessionLog(next: Info): () => void {
  if (info) return () => {};
  info = next;
  const removeSink = addLogSink((entry) => {
    lines.push(toLine(entry));
    if (lines.length > MEMORY_LINES) lines.splice(0, lines.length - MEMORY_LINES);
    dirty = true;
    timer ??= setTimeout(persistNow, PERSIST_EVERY_MS);
  });
  const onHidden = () => {
    if (document.visibilityState === "hidden") persistNow();
  };
  try {
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", persistNow);
  } catch {
    /* no document: memory only */
  }
  return () => {
    removeSink();
    try {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", persistNow);
    } catch {
      /* never throws */
    }
    clearTimeout(timer);
    timer = undefined;
    info = null;
    lines.length = 0;
    autoAttached = 0;
  };
}

function attachment(
  product: string,
  reason: string,
  from: Line[],
  session: string,
  release: string,
): Attachment | null {
  if (from.length === 0) return null;
  const body = (kept: Line[]) =>
    JSON.stringify({
      meta: {
        app: product,
        release,
        session,
        reason,
        lines: kept.length,
        first: kept[0]?.t,
        last: kept.at(-1)?.t,
      },
      lines: kept,
    });
  let kept = from;
  let data = body(kept);
  while (data.length > MAX_ATTACHMENT_CHARS && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    data = body(kept);
  }
  return {
    filename: `log-${product}-${session.slice(0, 8)}.json`,
    data: scrubText(data),
    contentType: "application/json",
  };
}

/** This page's log as an attachment, or null before it has a line. */
function sessionLogAttachment(reason: string): Attachment | null {
  try {
    return info ? attachment(info.product, reason, lines, info.sessionId, info.release) : null;
  } catch {
    return null;
  }
}

/** For init.ts's beforeSend: the log for the next unexpected error, while
 *  this page load has attached fewer than AUTO_ATTACH. */
export function autoAttachment(): Attachment | null {
  if (autoAttached >= AUTO_ATTACH) return null;
  const found = sessionLogAttachment("error");
  if (found) autoAttached += 1;
  return found;
}

/** What the previous page persisted, if it was that session. */
export function persistedLog(product: string, previousSessionId: string): Attachment | null {
  try {
    const raw = localStorage.getItem(key(product));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (stored.sessionId !== previousSessionId || !Array.isArray(stored.lines)) return null;
    return attachment(
      product,
      "previous-session",
      stored.lines,
      previousSessionId,
      String(stored.release ?? "unknown"),
    );
  } catch {
    return null;
  }
}
