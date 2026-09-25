// Keeps the crypto floors fresh for as long as the picker using them is on screen.

import { onMounted, onUnmounted } from "vue";
import { useOffersStore } from "../stores/offers";

export function useFreshFloors(): void {
  const offers = useOffersStore();
  let release: (() => void) | null = null;
  onMounted(() => {
    release = offers.keepFresh(document);
  });
  onUnmounted(() => {
    release?.();
    release = null;
  });
}
