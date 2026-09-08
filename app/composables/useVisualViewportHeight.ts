// Publishes the visual viewport as two CSS variables: --vvh for its height and --vvt for its top.
// Without the API the shell falls back to 100dvh at top 0.

import { onMounted, onUnmounted } from "vue";

export const VISUAL_VIEWPORT_HEIGHT_VAR = "--vvh";
export const VISUAL_VIEWPORT_TOP_VAR = "--vvt";

export function useVisualViewportHeight() {
  let detach: (() => void) | null = null;
  onMounted(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement.style;
    const apply = () => {
      root.setProperty(VISUAL_VIEWPORT_HEIGHT_VAR, `${viewport.height}px`);
      root.setProperty(VISUAL_VIEWPORT_TOP_VAR, `${viewport.offsetTop}px`);
    };
    apply();
    // resize: the keyboard opening or closing. scroll: offsetTop shifting.
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    detach = () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      root.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR);
      root.removeProperty(VISUAL_VIEWPORT_TOP_VAR);
    };
  });
  onUnmounted(() => detach?.());
}
