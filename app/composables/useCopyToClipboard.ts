import { onUnmounted, ref } from "vue";

/**
 * When the last successful copy happened, for anything that confirms one screen-wide.
 *
 * Module state on purpose: a screen's copy controls are independent of each other and of the
 * confirmation, so `CopiedPill` watches this instead of every control having to report upwards.
 * Only ever bumped, never read for its value.
 */
export const copiedAt = ref(0);

/** Clipboard write with a transient "copied" flag for the button label; a failed write only
 *  warns, leaving the flag down. */
export function useCopyToClipboard(resetMs = 2000) {
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      copiedAt.value += 1;
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
