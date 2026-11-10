/**
 * THE SESSION'S LOG, for a failure that needs more than its last 100
 * breadcrumbs: every devLog line of this page load, from its first, kept in
 * memory, already scrubbed (lib/log.ts), up to MEMORY_LINES.
 *
 * The log leaves the device only attached to the first AUTO_ATTACH unexpected
 * errors of a page load (init.ts), as `log-<app>-<session>.json`:
 * `{ meta, lines: [{ t, level, tag, message, data? }] }`, cut from its oldest
 * end to MAX_ATTACHMENT_CHARS and scrubbed once more as a whole. Never throws.
 */
import type * as Sentry from "@sentry/vue";
import { addLogSink, type LogEntry } from "../log";
import { scrubText } from "./scrub";

/** the SDK keeps its Attachment type to itself: the shape addAttachment takes */
type Attachment = Parameters<ReturnType<typeof Sentry.getCurrentScope>["addAttachment"]>[0];

const MEMORY_LINES = 3_000;
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

interface Info {
  product: string;
  release: string;
  sessionId: string;
}

const lines: Line[] = [];
let info: Info | null = null;
let autoAttached = 0;

const toLine = (entry: LogEntry): Line => ({
  t: entry.time,
  level: entry.level,
  tag: entry.tag,
  message: entry.message,
  ...(entry.data !== undefined ? { data: entry.data } : {}),
});

/** Start keeping this page's lines; returns the remover. */
export function installSessionLog(next: Info): () => void {
  if (info) return () => {};
  info = next;
  const removeSink = addLogSink((entry) => {
    lines.push(toLine(entry));
    if (lines.length > MEMORY_LINES) lines.splice(0, lines.length - MEMORY_LINES);
  });
  return () => {
    removeSink();
    info = null;
    lines.length = 0;
    autoAttached = 0;
  };
}

/** This page's log as an attachment, or null before it has a line. */
function sessionLogAttachment(): Attachment | null {
  if (!info || lines.length === 0) return null;
  const { product, release, sessionId } = info;
  const body = (kept: Line[]) =>
    JSON.stringify({
      meta: {
        app: product,
        release,
        session: sessionId,
        lines: kept.length,
        first: kept[0]?.t,
        last: kept.at(-1)?.t,
      },
      lines: kept,
    });
  let kept = lines;
  let data = body(kept);
  while (data.length > MAX_ATTACHMENT_CHARS && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    data = body(kept);
  }
  return {
    filename: `log-${product}-${sessionId.slice(0, 8)}.json`,
    data: scrubText(data),
    contentType: "application/json",
  };
}

/** For init.ts's beforeSend: the log for the next unexpected error, while
 *  this page load has attached fewer than AUTO_ATTACH. */
export function autoAttachment(): Attachment | null {
  if (autoAttached >= AUTO_ATTACH) return null;
  try {
    const found = sessionLogAttachment();
    if (found) autoAttached += 1;
    return found;
  } catch {
    return null;
  }
}
