// Follow the Polkadot host's theme while running inside its container. The host
// pushes { name, variant } over getThemeProvider().subscribeTheme(); each update
// lands on data-theme via setTheme(), which also persists it so the anti-flash
// script paints the right theme on the next load. In-host the theme is the
// host's call — there is no picker. Standalone keeps the localStorage path
// (anti-flash script + setTheme) untouched; prefers-color-scheme can't stand in
// for this, since in a webview it tracks the OS, not the in-app theme choice.
import { onMounted, onUnmounted } from "vue";
import { getThemeProvider, type HostSubscription } from "@parity/product-sdk-host";
import { isHosted } from "~~/lib/host-account";
import { setTheme, themeFromHost } from "../theme/theme";

export function useHostTheme(): void {
  let sub: HostSubscription | null = null;
  let disposed = false;

  onMounted(async () => {
    if (!isHosted()) return;
    const provider = await getThemeProvider();
    if (!provider) return;
    if (disposed) return;
    sub = provider.subscribeTheme((mode) => setTheme(themeFromHost(mode)));
  });

  onUnmounted(() => {
    disposed = true;
    sub?.unsubscribe();
  });
}
