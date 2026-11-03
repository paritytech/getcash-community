/**
 * THE TELEMETRY CORE: everything that imports @sentry/vue, reached only
 * through the doorway's guarded dynamic import (index.ts), so a build without
 * a DSN has none of it. Every function:
 *
 *  - starts Sentry first if nobody has (`startTelemetry` is idempotent);
 *  - is a no-op when Sentry did not start (no usable DSN, no browser);
 *  - never throws.
 *
 * Framework-free: nothing here pulls in Vue.
 */
import * as Sentry from "@sentry/vue";
import type { AppTag, FailureKind, JourneyName } from "./catalogue";
import { telemetryLive } from "./boot";
import { sendFailure, type FailureDetails } from "./failures";
import { noopJourney, type Attrs, type Journey } from "./handle";
import { createJourney } from "./journeys";

export { startTelemetry } from "./boot";
export { trackAction } from "./actions";
export { enterScreen, leaveScreen } from "./screens";
export { requestTelemetryGrant } from "./grant";

/** One of the app's own scope tags (APP_TAGS in catalogue.ts); undefined removes it. */
export function setTelemetryTag(key: AppTag, value: string | undefined): void {
  try {
    if (telemetryLive()) Sentry.setTag(key, value);
  } catch {
    /* never throws */
  }
}

/** Send one deliberate failure event of a fixed kind. With a journey, its
 *  `journey.expected` follows the failure. */
export function reportFailure(kind: FailureKind, details: FailureDetails, journey?: Journey): void {
  try {
    if (telemetryLive()) sendFailure(kind, details, journey);
  } catch {
    /* never throws */
  }
}

/** Start a journey. A no-op handle when telemetry is off; never throws. */
export function startJourney<N extends JourneyName>(name: N, attrs?: Attrs): Journey<N> {
  try {
    return telemetryLive() ? createJourney(name, attrs) : noopJourney(name);
  } catch {
    return noopJourney(name);
  }
}
