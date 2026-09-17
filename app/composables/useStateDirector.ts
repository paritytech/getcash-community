// Demo-build keyboard director. Ctrl+Shift+N / P cycles preview scenes, R reloads, F presses the
// faucet, H forces a transport reconnect.

import { onMounted, onUnmounted, ref } from "vue";
import { useSessionStore } from "../stores/session";
import { isDemoBuild } from "../utils/demo";
import { directScene } from "../utils/dev-preview";

/**
 * The scene on screen, as `PreviewSceneLabel` draws it. Module state, not per-caller: the keys are
 * handled by whichever container is up, and a scene usually lands on a different one.
 */
export const previewLabel = ref<string | null>(null);

export function useStateDirector() {
  const session = useSessionStore();

  function onDemoKeys(e: KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.key === "N") {
      previewLabel.value = directScene(1);
    } else if (e.key === "P") {
      previewLabel.value = directScene(-1);
    } else if (e.key === "R") {
      window.location.reload();
    } else if (e.key === "F") {
      void session.fundFaucet();
    } else if (e.key === "H") {
      // Dev fault hook for the in-place reconnect.
      console.warn("[coinage] DEV: forcing a transport reconnect");
      session.reconnectChains();
    }
  }

  onMounted(() => {
    if (isDemoBuild()) window.addEventListener("keydown", onDemoKeys);
  });
  onUnmounted(() => window.removeEventListener("keydown", onDemoKeys));
}
