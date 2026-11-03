// A screen names itself for telemetry while it is mounted, so the time on it is measured under
// its own name (lib/telemetry/screens.ts). The name can follow the container's own switch; null
// is a state that is no screen of its own (a skeleton). Call it in the component that switches
// between screens, never in both a container and a screen inside it: Vue mounts the child
// first, so the outer one would win.

import { onMounted, onUnmounted, toValue, watch, type MaybeRefOrGetter } from "vue";
import { enterScreen, leaveScreen, type ScreenName } from "~~/lib/telemetry";

export function useScreen(screen: MaybeRefOrGetter<ScreenName | null>): void {
  let current: ScreenName | null = null;
  const show = (next: ScreenName | null) => {
    if (next === current) return;
    if (current) leaveScreen(current);
    current = next;
    if (next) enterScreen(next);
  };
  onMounted(() => {
    watch(() => toValue(screen), show, { immediate: true });
  });
  onUnmounted(() => show(null));
}
