// Reads Meld's asset codes from the adapter before the root component mounts (and before the
// requests plugin, which runs after this one by name), so the first screen's catalog and quotes
// go out under the codes the adapter names. Bounded: an adapter that is slow or down must not
// hold the app's first paint, and every Meld call asks again before it names a code.
import { pageMeldAssets } from "~~/lib/meld-assets";

/** How long the boot waits for the table before mounting without it. */
const BOOT_WAIT_MS = 3_000;

export default defineNuxtPlugin(async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BOOT_WAIT_MS);
  });
  try {
    await Promise.race([pageMeldAssets(), waited]);
  } catch (error) {
    console.warn(
      "[meld] could not read the adapter's asset codes at boot; retrying on first use",
      error,
    );
  } finally {
    clearTimeout(timer);
  }
});
