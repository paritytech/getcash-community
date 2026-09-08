// Reconnects the chain clients when the page returns to the foreground after a real background
// stint or a bfcache restore.

import { onMounted, onUnmounted } from "vue";
import { useSessionStore } from "../stores/session";

const HIDDEN_EVICT_MS = 5_000;

export function useVisibilityReconcile() {
  const session = useSessionStore();
  let hiddenAt: number | null = null;

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const hiddenMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (hiddenMs < HIDDEN_EVICT_MS) return; // a quick app-switch flash
    if (!session.live) return; // nothing chain-bound is running
    console.info(`[chain] foreground after ${Math.round(hiddenMs / 1000)}s hidden, reconnecting`);
    session.reconnectChains();
  };

  // A bfcache restore is treated as a background.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted && session.live) session.reconnectChains();
  };

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
  });
  onUnmounted(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
  });
}
