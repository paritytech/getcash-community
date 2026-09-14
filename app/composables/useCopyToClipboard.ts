import { onUnmounted, ref } from "vue";

/** Clipboard write with a transient "copied" flag for the button label; a failed write only
 *  warns, leaving the flag down. */
export function useCopyToClipboard(resetMs = 2000) {
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => (copied.value = false), resetMs);
    } catch (e) {
      console.warn("[clipboard] write failed:", e);
    }
  }
  onUnmounted(() => {
    if (timer !== null) clearTimeout(timer);
  });
  return { copied, copy };
}
