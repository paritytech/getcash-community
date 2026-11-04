/**
 * THE BOOT: start Sentry once, and the live rule every doorway function
 * checks. Its own module so the doorway's siblings can share the rule
 * without importing the index.
 *
 * A page the OS or the person killed is not reported by the next open: the
 * signal cannot tell a crash from a person leaving, and the worker carries a
 * request on without the page, so it would mostly be noise.
 */
import { configFromEnvironment } from "./config";
import { watchForeground } from "./foreground";
import { logBoot, startTelemetryWith, telemetryStarted, type TelemetryConfig } from "./init";
import { installSessionLog } from "./session-log";

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
    installSessionLog({
      product: config.product,
      sessionId: config.sessionId,
      release: config.release,
    });
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
