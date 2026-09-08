import { onMounted, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

const MIN_CADENCE_MS = 1_000;

function cadenceMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? Math.max(MIN_CADENCE_MS, value) : MIN_CADENCE_MS;
}

export function useFundingProgressClock(
  cadence: MaybeRefOrGetter<number | null | undefined>,
): Readonly<Ref<number>> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let mounted = false;

  const tick = () => {
    now.value = Math.max(now.value, Date.now());
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    const delay = cadenceMs(toValue(cadence));
    if (!mounted || delay === null || document.visibilityState === "hidden") return;
    tick();
    timer = setInterval(tick, delay);
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      stop();
      return;
    }
    start();
  };

  watch(() => toValue(cadence), start);
  onMounted(() => {
    mounted = true;
    document.addEventListener("visibilitychange", onVisibility);
    start();
  });
  onUnmounted(() => {
    mounted = false;
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
  });

  return now;
}
