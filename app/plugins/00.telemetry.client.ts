// Telemetry first, before any other plugin, so a store or screen that starts a journey finds
// Sentry running. A build without a DSN resolves at once and carries no Sentry code
// (lib/telemetry/index.ts).

import { startTelemetry } from "~~/lib/telemetry";
import { startAppOpen } from "~~/lib/app-open";

export default defineNuxtPlugin(async (nuxtApp) => {
  await startTelemetry(nuxtApp.vueApp);
  startAppOpen();
});
