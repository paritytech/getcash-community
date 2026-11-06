// The app-open journey: from the telemetry boot to the first usable screen. Its steps are the
// stored requests read from the host and the host's network grant answered; it ends once both
// are in, `ready` in a host and `browser` outside one.

import { startJourney, type Journey, type Step } from "./telemetry";

let journey: Journey<"app-open"> | null = null;
let records: Step | null = null;
let recordsRead = false;
let permissions: "pending" | "host" | "browser" = "pending";

function finish(): void {
  if (!journey || !recordsRead || permissions === "pending") return;
  journey.end(permissions === "host" ? "ready" : "browser");
  journey = null;
}

/** The page is booting. Once per page load. */
export function startAppOpen(): void {
  if (journey) return;
  journey = startJourney("app-open");
  records = journey.step("records");
}

/** The stored requests have been read from the host (or the read gave up). */
export function appOpenRecordsRead(): void {
  if (recordsRead) return;
  recordsRead = true;
  records?.end();
  finish();
}

/** Ask the host's launch prompts through `ask`, timed as the journey's permission step. */
export async function appOpenHostPermissions<T>(ask: () => Promise<T>): Promise<T> {
  const step = permissions === "pending" ? journey?.step("host.permissions") : undefined;
  try {
    return await ask();
  } finally {
    step?.end();
    if (permissions === "pending") {
      permissions = "host";
      finish();
    }
  }
}

/** Outside a host there is nothing to ask. */
export function appOpenOutsideHost(): void {
  if (permissions !== "pending") return;
  permissions = "browser";
  finish();
}
