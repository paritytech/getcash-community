<script setup lang="ts">
// The payment step: embeds the provider's hosted widget edge to edge and polls the Meld status from
// the moment it opens. Once the buyer finishes, a small loader replaces the widget while the poll
// confirms.
import { onMounted, onUnmounted } from "vue";
import { CircleX } from "lucide-vue-next";
import { useSessionStore } from "../../../stores/session";

defineProps<{ payUrl?: string | null }>();

const session = useSessionStore();

// The return page posts `meld:paid` from the adapter origin; only that origin is trusted.
const ADAPTER_ORIGIN = (() => {
  const base = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  try {
    return base ? new URL(base).origin : null;
  } catch {
    return null;
  }
})();
async function onMessage(e: MessageEvent) {
  if (!ADAPTER_ORIGIN || e.origin !== ADAPTER_ORIGIN) return;
  // Awaited: the submitted stamp is persisted before the buyer can navigate away.
  if ((e.data as { type?: string } | null)?.type === "meld:paid") await session.markMeldSubmitted();
}

onMounted(() => {
  window.addEventListener("message", onMessage);
  session.pollMeldStatus();
});
onUnmounted(() => window.removeEventListener("message", onMessage));
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <!-- The hosted widget until the buyer finishes, then a small loader while the poll
         confirms. -->
    <div
      v-if="session.meldStage === 'failed'"
      class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
    >
      <CircleX class="size-8 text-fg-error" aria-hidden="true" />
      <!-- The adapter's own reason: the four failure states are not interchangeable, and
           `unobserved` (the buyer may have been charged) must not read as "try again". -->
      <p class="max-w-[240px] text-label-m text-fg-error">
        {{ session.meldFailureMessage ?? "Payment could not be completed" }}
      </p>
    </div>
    <div
      v-else-if="session.meldSubmitted"
      class="flex min-h-0 w-full flex-1 items-center justify-center"
    >
      <span class="size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary" />
    </div>
    <!-- `*`, not the bare feature name. Bare `payment` means `payment 'src'`, which delegates
         only to this iframe's origin. Meld's widget nests the chosen provider's page in a
         further cross-origin iframe, where the card fields live, so a feature that stops at the
         outer frame never reaches them. `*` delegates down the whole chain, which is what Apple
         Pay / Google Pay and the provider's own PaymentRequest calls need. The provider is
         picked per corridor, so an explicit origin allowlist would have to track Meld's roster
         and would break the moment they route to a new one. -->
    <!-- No background of our own behind the widget: the provider's page paints itself
         (light) the moment it loads, and any surface we put there is wrong in half the
         themes for the frame it shows. -->
    <iframe
      v-else-if="payUrl"
      :src="payUrl"
      class="min-h-0 w-full flex-1 border-0"
      title="Secure payment"
      allow="payment *; camera *; clipboard-write *"
    />
    <p v-else class="flex-1 py-8 text-center text-body-m text-fg-tertiary">
      Preparing secure payment…
    </p>
  </div>
</template>
