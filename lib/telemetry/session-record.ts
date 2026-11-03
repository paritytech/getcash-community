/**
 * THE LAST-SESSION RECORD: how the previous page load ended, told by the
 * next one.
 *
 * A webview the OS kills runs no cleanup, so the only witness is a small
 * localStorage record the page keeps current while it is alive: every
 * HEARTBEAT_MS while visible, soon after any journey changes, and at once at
 * each lifecycle edge (hidden, shown, pagehide). The next page load
 * reads it once, classifies it, and replaces it with its own:
 *
 *   clean-close               pagehide ran: the person (or the host) closed the app
 *   killed-background         last seen hidden, no pagehide: the OS reclaimed it
 *   crash-or-kill-foreground  last seen VISIBLE, no pagehide: a crash, an
 *                             out-of-memory kill or a host reload
 *   host-reload               the same tab came back within HOST_RELOAD_MAX_GAP_MS
 *   unknown                   no record, or one older than STALE_AFTER_MS
 *
 * The record carries the screen and the journeys still open, which the
 * next open names in its report (previous.ts). It lives in the page's own
 * localStorage, never host storage, as session-log.ts says why. Never throws.
 */
import { openJourneyRecords, setOpenJourneyListener, type OpenJourneyRecord } from "./journeys";
import { currentScreen } from "./screens";

const HEARTBEAT_MS = 20_000;
const HOST_RELOAD_MAX_GAP_MS = 45_000;
const STALE_AFTER_MS = 30 * 60_000;
/** a journey change is written within this, not on every step */
const CHANGE_WRITE_MS = 1_000;

type PreviousExit =
  "clean-close" | "killed-background" | "crash-or-kill-foreground" | "host-reload" | "unknown";

export interface SessionRecord {
  sessionId: string;
  release: string;
  /** one per browser tab (sessionStorage): a reload of the same tab keeps it */
  lineage: string;
  startedAt: number;
  lastSeenAt: number;
  cleanExit: boolean;
  hidden: boolean;
  screen: string;
  journeys: OpenJourneyRecord[];
}

export interface PreviousSession {
  exit: PreviousExit;
  record: SessionRecord | null;
  gapMs?: number;
}

let current: SessionRecord | null = null;
let storageKey = "";
let timer: ReturnType<typeof setInterval> | undefined;
let pending: ReturnType<typeof setTimeout> | undefined;
let removers: Array<() => void> = [];

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function lineage(product: string, fallback: string): string {
  try {
    const name = `sentry:${product}:lineage`;
    const known = sessionStorage.getItem(name);
    if (known) return known;
    sessionStorage.setItem(name, fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is SessionRecord {
  const record = value as Partial<SessionRecord> | null;
  return (
    !!record &&
    typeof record.sessionId === "string" &&
    typeof record.lastSeenAt === "number" &&
    typeof record.cleanExit === "boolean"
  );
}

function write(over: Partial<SessionRecord> = {}): void {
  try {
    if (!current) return;
    current = {
      ...current,
      hidden: pageHidden(),
      screen: currentScreen(),
      journeys: openJourneyRecords(),
      ...over,
      lastSeenAt: Date.now(),
    };
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch {
    /* full or blocked storage: the next open reads "unknown" */
  }
}

/** Classify the previous page load. Pure, for tests. */
export function classify(
  previous: SessionRecord | null,
  now: number,
  currentLineage: string,
): PreviousSession {
  if (!previous) return { exit: "unknown", record: null };
  const gapMs = now - previous.lastSeenAt;
  let exit: PreviousExit;
  if (gapMs < 0 || gapMs >= STALE_AFTER_MS) exit = "unknown";
  else if (
    previous.lineage === currentLineage &&
    gapMs <= HOST_RELOAD_MAX_GAP_MS &&
    !previous.cleanExit
  )
    exit = "host-reload";
  else if (previous.cleanExit) exit = "clean-close";
  else if (previous.hidden) exit = "killed-background";
  else exit = "crash-or-kill-foreground";
  return { exit, record: previous, gapMs: gapMs >= 0 ? gapMs : undefined };
}

/**
 * Read and classify the previous page load, then start keeping this one's
 * record. Call once, at boot, before anything else writes the record.
 */
export function startSessionRecord(info: {
  product: string;
  sessionId: string;
  release: string;
}): PreviousSession {
  if (current) return { exit: "unknown", record: null };
  storageKey = `sentry:${info.product}:last-session.v1`;
  const now = Date.now();
  let previous: SessionRecord | null = null;
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    previous = isRecord(parsed) ? parsed : null;
  } catch {
    previous = null;
  }
  const tab = lineage(info.product, info.sessionId);
  const result = classify(previous, now, tab);
  current = {
    sessionId: info.sessionId,
    release: info.release,
    lineage: tab,
    startedAt: now,
    lastSeenAt: now,
    cleanExit: false,
    hidden: pageHidden(),
    screen: "none",
    journeys: [],
  };
  write();
  try {
    timer = setInterval(() => {
      if (!pageHidden()) write();
    }, HEARTBEAT_MS);
    setOpenJourneyListener(() => {
      pending ??= setTimeout(() => {
        pending = undefined;
        write();
      }, CHANGE_WRITE_MS);
    });
    const onPagehide = () => write({ cleanExit: true });
    // shown again after a pagehide (back from the bfcache): alive, not closed
    const onVisibility = () => write(pageHidden() ? {} : { cleanExit: false });
    window.addEventListener("pagehide", onPagehide);
    document.addEventListener("visibilitychange", onVisibility);
    removers = [
      () => window.removeEventListener("pagehide", onPagehide),
      () => document.removeEventListener("visibilitychange", onVisibility),
    ];
  } catch {
    /* the record still stands; it just ages */
  }
  return result;
}

export function resetSessionRecordForTests(): void {
  for (const remove of removers) remove();
  removers = [];
  clearInterval(timer);
  clearTimeout(pending);
  timer = undefined;
  pending = undefined;
  current = null;
  setOpenJourneyListener(null);
}
