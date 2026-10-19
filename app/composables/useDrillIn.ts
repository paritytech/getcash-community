import { ref, type Ref } from "vue";

/** A drill-in opened from one of several screens, so that Back returns to the one that opened
 *  it. `show` puts the drill-in on screen. */
export function useDrillIn<From extends string>(initial: From, show: () => void) {
  const from = ref(initial) as Ref<From>;
  const open = (origin: From): void => {
    from.value = origin;
    show();
  };
  return { from, open };
}
