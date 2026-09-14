// The resolved theme KIND ('light' | 'dark') as a reactive value, for JS that must
// branch on it — third-party widgets taking a light/dark prop (vue-sonner's Toaster).
// The visual layer never needs this: semantic tokens re-theme through CSS alone.
// Tracks both the data-theme attribute (set by setTheme / the anti-flash script) and
// the OS preference while no attribute is set.
import { onMounted, onUnmounted, readonly, ref, type Ref } from "vue";
import { DARK_THEMES, resolveTheme } from "../theme/theme";

export function useResolvedThemeKind(): Readonly<Ref<"light" | "dark">> {
  // Berlin Night is the product default (the anti-flash script pins it), so the
  // pre-mount value is dark.
  const kind = ref<"light" | "dark">("dark");
  let observer: MutationObserver | null = null;
  let stopSystemWatch: (() => void) | null = null;

  function update() {
    const theme = document.documentElement.getAttribute("data-theme") ?? resolveTheme("system");
    kind.value = (DARK_THEMES as readonly string[]).includes(theme) ? "dark" : "light";
  }

  onMounted(() => {
    update();
    observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    stopSystemWatch = () => mq.removeEventListener("change", update);
  });

  onUnmounted(() => {
    observer?.disconnect();
    stopSystemWatch?.();
  });

  return readonly(kind);
}
