/**
 * THE BOOT: start Sentry once, and the live rule every doorway function
 * checks. Its own module so the doorway's siblings can share the rule
 * without importing the index.
 *
 * The order is load-bearing: the previous page's record and persisted log
 * are read (and reported) before this page starts writing its own over
 * them, and only then does this page's log, foreground watch and record
 * begin.
 */
import { configFromEnvironment } from "./config";
import { watchForeground } from "./foreground";
import { logBoot, startTelemetryWith, telemetryStarted, type TelemetryConfig } from "./init";
import { reportPreviousSession } from "./previous";
import { installSessionLog, persistedLog } from "./session-log";
import { startSessionRecord } from "./session-record";

let booted = false;

/** Start Sentry once. A no-op without a DSN, or outside a browser. The
 *  doorway passes the Vue app on the first call. */
export function startTelemetry(app?: TelemetryConfig["app"]): void {
  if (booted) return;
  booted = true;
  try {
    const config = configFromEnvironment();
    if (config && app) config.app = app;
    if (!config || !startTelemetryWith(config)) return;
    const session = {
      product: config.product,
      sessionId: config.sessionId,
      release: config.release,
    };
    const previous = startSessionRecord(session);
    // read now: this page's log will be written over it
    const previousLog = previous.record
      ? persistedLog(config.product, previous.record.sessionId)
      : null;
    reportPreviousSession(previous, previousLog);
    installSessionLog(session);
    logBoot(config);
    watchForeground();
  } catch {
    /* telemetry never breaks the app */
  }
}

/** Sentry is running. Starts it first if nobody has. */
export function telemetryLive(): boolean {
  try {
    startTelemetry();
    return telemetryStarted();
  } catch {
    return false;
  }
}
