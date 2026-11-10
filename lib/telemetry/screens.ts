/**
 * SCREENS: which screen the person is on, and for how long. Framework-free:
 * a screen only says it is on screen (`useScreen`, app/composables); the
 * measuring is here.
 *
 * For each visit to a screen (SCREENS in catalogue.ts):
 *
 *   ui.screen_ms   distribution, millisecond   a visible stretch on it, by `screen`
 *                                              (sum them for the time on it)
 *
 * A visit's visible time is sent when it ends, when the page turns hidden (a
 * hidden page may never come back), and every REPORT_MS on a long visit.
 * Nothing is sent until Sentry has started. Never throws.
 */
import { SCREENS, type ScreenName } from "./catalogue";
import { devLog } from "../log";
import { telemetryStarted } from "./init";
import { recordDistribution } from "./metrics";

export type { ScreenName };

const REPORT_MS = 60_000;

interface Visit {
  screen: ScreenName;
  /** visible ms banked so far, and since when it is visible again */
  visibleMs: number;
  visibleSince: number | null;
  lastReport: number;
}

let visit: Visit | null = null;
let installed = false;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** The screen on screen now, for a log line or an action's attribute. */
export function currentScreen(): ScreenName | "none" {
  return visit?.screen ?? "none";
}

/** Send this visit's visible time since its last report. */
function report(): void {
  if (!visit || !telemetryStarted()) return;
  const visible = visit.visibleMs + (visit.visibleSince === null ? 0 : now() - visit.visibleSince);
  if (visible > 0)
    recordDistribution("ui.screen_ms", visible, "millisecond", { screen: visit.screen });
  visit.visibleMs = 0;
  if (visit.visibleSince !== null) visit.visibleSince = now();
  visit.lastReport = now();
}

function onInteraction(): void {
  if (visit && !hidden() && now() - visit.lastReport > REPORT_MS) report();
}

function onVisibility(): void {
  if (!visit) return;
  if (hidden()) {
    if (visit.visibleSince !== null) visit.visibleMs += now() - visit.visibleSince;
    visit.visibleSince = null;
    report();
  } else {
    visit.visibleSince = now();
  }
}

function install(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  window.addEventListener("pointerdown", onInteraction, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);
}

/** `screen` is on screen now. A screen already open is left first. */
export function enterScreen(screen: ScreenName): void {
  try {
    if (!(SCREENS as readonly string[]).includes(screen)) return;
    if (visit?.screen === screen) return;
    if (visit) leaveScreen(visit.screen);
    install();
    visit = { screen, visibleMs: 0, visibleSince: hidden() ? null : now(), lastReport: now() };
    devLog("screen", `open ${screen}`);
  } catch {
    /* never throws */
  }
}

/** `screen` is gone. Leaving a screen that is not the current one does nothing. */
export function leaveScreen(screen: ScreenName): void {
  try {
    if (visit?.screen !== screen) return;
    report();
    visit = null;
  } catch {
    /* never throws */
  }
}
