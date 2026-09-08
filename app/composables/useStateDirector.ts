// Demo-build keyboard director. Ctrl+Shift+N / P cycles preview scenes, R reloads, F presses the
// faucet, H forces a transport reconnect.

import { onMounted, onUnmounted, ref } from "vue";
import { useFlowStore } from "../stores/flow";
import { useSessionStore } from "../stores/session";
import { isDemoBuild } from "../utils/demo";
import { directScene } from "../utils/dev-preview";

export function useStateDirector() {
  const session = useSessionStore();
  const flow = useFlowStore();
  const previewLabel = ref<string | null>(null);

  function onDemoKeys(e: KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.key === "N") {
      previewLabel.value = directScene(session, flow, 1);
    } else if (e.key === "P") {
      previewLabel.value = directScene(session, flow, -1);
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

  return { previewLabel };
}
