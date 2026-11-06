// The rows a picker shows while a pick it made is starting. The pick quotes again, and until that
// quote is in, the offers have no figure to hold a floor against, so every greyed row would read
// as still being answered and turn pickable. The rows stay as they stood at the tap instead.

import { computed, shallowRef, watch, type ComputedRef } from "vue";

export interface HeldRows<T> {
  /** The live rows, or the ones held at the tap while the pick is starting. */
  rows: ComputedRef<T>;
  /** Takes the rows as they stand now. Call it before the pick touches the source. */
  hold: () => void;
}

export function useHeldRows<T>(live: () => T, starting: () => boolean): HeldRows<T> {
  const held = shallowRef<{ rows: T } | null>(null);
  watch(starting, (now) => {
    if (!now) held.value = null;
  });
  const rows = computed(() => (starting() && held.value !== null ? held.value.rows : live()));
  return {
    rows,
    hold: () => {
      held.value = { rows: live() };
    },
  };
}
