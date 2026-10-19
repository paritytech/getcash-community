// Starts reading Meld's asset codes from the adapter as the page boots, so the first catalog or
// quote usually finds them already read. Not awaited: an adapter that is slow or down must not hold
// the app's first paint, and every call that names a Meld code waits on this same read (or asks
// again after it failed) before it does.
import { pageMeldAssets } from "~~/lib/meld-assets";

export default defineNuxtPlugin(() => {
  pageMeldAssets().catch((error: unknown) => {
    console.warn(
      "[meld] could not read the adapter's asset codes at boot; retrying on first use",
      error,
    );
  });
});
