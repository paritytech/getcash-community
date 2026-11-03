// Telemetry first, before the app's other plugins (`enforce: "pre"`), so a store or screen that
// starts a journey finds Sentry running. A build without a DSN resolves at once and carries no
// Sentry code (lib/telemetry/index.ts). With one, the app waits for Sentry's code at most
// STARTUP_WAIT_MS: on a slow load it mounts without it, telemetry starts when the code arrives,
// and only that open's app-open journey is missed.

import { startTelemetry } from "~~/lib/telemetry";
import { startAppOpen } from "~~/lib/app-open";

const STARTUP_WAIT_MS = 1_000;

export default defineNuxtPlugin({
  name: "telemetry",
  enforce: "pre",
  async setup(nuxtApp) {
    await Promise.race([
      startTelemetry(nuxtApp.vueApp),
      new Promise<void>((resolve) => setTimeout(resolve, STARTUP_WAIT_MS)),
    ]);
    startAppOpen();
  },
});
