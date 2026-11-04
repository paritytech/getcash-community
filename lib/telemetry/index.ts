/// <reference path="./globals.d.ts" />
/**
 * THE TELEMETRY DOORWAY. The rest of the app calls these and never sees
 * Sentry: this file is the only telemetry module app code imports, and it
 * imports nothing that does.
 *
 * TELEMETRY IS A BUILD'S OPT-IN. The core (core.ts and everything that
 * imports @sentry/vue behind it) is loaded by one dynamic import, inside a
 * branch on the DSN literal nuxt.config.ts defines. A build without
 * VITE_SENTRY_DSN folds that branch away, and the bundler drops the import
 * with it: the build carries no Sentry code and makes no request to Sentry.
 * CI checks it (build-site).
 *
 * Until the core is loaded, and always in a build without a DSN, every
 * function here is a no-op. The telemetry plugin loads it before the app
 * mounts. Every function never throws.
 */
import type * as Core from "./core";
import type { ActionName, AppTag, FailureKind, ScreenName } from "./catalogue";
import type { FailureDetails } from "./failures";
import { noopJourney, type Attrs, type Journey, type JourneyName } from "./handle";
import type { TelemetryConfig } from "./init";

export { describeError, reasonOf } from "./scrub";
export { isExpected } from "./catalogue";
export type { FailureDetails, FailureKind, ScreenName };
export type { Attrs, Journey, OutcomeOf, Step, StepOf } from "./handle";

let core: typeof Core | null = null;
let loading: Promise<void> | null = null;
/** The grant was asked for before the core loaded (the app mounts without waiting long for it),
 *  so it is asked once the core is running: else the gate would never open for this page. */
let grantWanted = false;

/** Load the core and start Sentry, once. Resolves when it is running, or at
 *  once in a build without a DSN. */
export function startTelemetry(app?: TelemetryConfig["app"]): Promise<void> {
  if (__SENTRY_DSN__ === null) return Promise.resolve();
  loading ??= import("./core")
    .then((loaded) => {
      loaded.startTelemetry(app);
      core = loaded;
      if (grantWanted) void loaded.requestTelemetryGrant();
    })
    .catch(() => {
      /* telemetry never breaks the app */
    });
  return loading;
}

/** Start a journey. A no-op handle when telemetry is off. */
export function startJourney<N extends JourneyName>(name: N, attrs?: Attrs): Journey<N> {
  try {
    return core ? core.startJourney(name, attrs) : noopJourney(name);
  } catch {
    return noopJourney(name);
  }
}

/** Send one deliberate failure event of a fixed kind (catalogue.ts). */
export function reportFailure(kind: FailureKind, details: FailureDetails, journey?: Journey): void {
  try {
    core?.reportFailure(kind, details, journey);
  } catch {
    /* never throws */
  }
}

/** An error Vue or Nuxt caught, from the telemetry plugin's hooks. */
export function reportVueError(error: unknown, info?: string): void {
  try {
    core?.reportVueError(error, info);
  } catch {
    /* never throws */
  }
}

/** One of the app's own scope tags (APP_TAGS in catalogue.ts); undefined removes it. */
export function setTelemetryTag(key: AppTag, value: string | undefined): void {
  try {
    core?.setTelemetryTag(key, value);
  } catch {
    /* never throws */
  }
}

/** Count a user action (ACTIONS in catalogue.ts) and log it. */
export function trackAction(action: ActionName, attrs?: Record<string, string>): void {
  try {
    core?.trackAction(action, attrs);
  } catch {
    /* never throws */
  }
}

/** `screen` is on screen now (SCREENS in catalogue.ts). */
export function enterScreen(screen: ScreenName): void {
  try {
    core?.enterScreen(screen);
  } catch {
    /* never throws */
  }
}

/** `screen` is gone. */
export function leaveScreen(screen: ScreenName): void {
  try {
    core?.leaveScreen(screen);
  } catch {
    /* never throws */
  }
}

/** Ask the host for Sentry's ingest domain, once per page (grant.ts). Never
 *  blocks; callers do not await it. */
export function requestTelemetryGrant(): void {
  try {
    if (core) void core.requestTelemetryGrant();
    else grantWanted = true;
  } catch {
    /* never throws */
  }
}
