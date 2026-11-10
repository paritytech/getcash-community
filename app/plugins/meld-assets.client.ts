// Starts reading Meld's asset codes from the adapter as the page boots, so the first catalog or
// quote usually finds them already read, then reads the region catalog behind them, so the
// region picker has its catalog by the time a card or bank route opens. Not awaited: an adapter
// that is slow or down must not hold the app's first paint, and every call that names a Meld code
// waits on this same read (or asks again after it failed) before it does.
import { pageMeldAssets } from "~~/lib/meld-assets";
import { useSessionStore } from "../stores/session";
import { devLog } from "~~/lib/log";

export default defineNuxtPlugin(() => {
  const session = useSessionStore();
  pageMeldAssets()
    .then(() => session.loadSupportedCatalog())
    .catch((error: unknown) => {
      devLog(
        "meld",
        "could not read the adapter's asset codes at boot; retrying on first use",
        error,
        "warn",
      );
    });
});
