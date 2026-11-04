// Telemetry first, before the app's other plugins (`enforce: "pre"`), so a store or screen that
// starts a journey finds Sentry running. A build without a DSN resolves at once and carries no
// Sentry code (lib/telemetry/index.ts). With one, the app waits for Sentry's code at most
// STARTUP_WAIT_MS: on a slow load it mounts without it, telemetry starts when the code arrives,
// and only that open's app-open journey is missed.
//
// Vue's errors are reported from Nuxt's hooks, as @sentry/nuxt does, so the app's error handler
// stays Nuxt's (lib/telemetry/init.ts says why). Nuxt's 3xx and 4xx errors (a redirect, a page
// not found) are not reported.

import { reportVueError, startTelemetry } from "~~/lib/telemetry";
import { startAppOpen } from "~~/lib/app-open";

const STARTUP_WAIT_MS = 1_000;

export default defineNuxtPlugin({
  name: "telemetry",
  enforce: "pre",
  async setup(nuxtApp) {
    nuxtApp.hook("vue:error", (error, _instance, info) => reportVueError(error, info));
    nuxtApp.hook("app:error", (error) => {
      const status = isNuxtError(error) ? (error.statusCode ?? 500) : 500;
      if (status >= 300 && status < 500) return;
      reportVueError(error);
    });
    await Promise.race([
      startTelemetry(nuxtApp.vueApp),
      new Promise<void>((resolve) => setTimeout(resolve, STARTUP_WAIT_MS)),
    ]);
    startAppOpen();
  },
});
