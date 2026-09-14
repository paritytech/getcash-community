<script setup lang="ts">
// A fiat top-up opened from the list while its payment is still to be made: brings the request to
// the foreground, shows the widget, and hands off once the payment is approved.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useMeldHandoff } from "../../../composables/useMeldHandoff";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import { fundingSelectorConfig } from "../../../funding/config";
import type { FundingPackageEmits } from "../../../funding/handoff";
import { meldRequestRef } from "../../../funding/meld-top-ups";
import type { FundingTopUp } from "../../../funding/top-ups";
import { useSessionStore } from "../../../stores/session";
import MeldPaySheet from "./MeldPaySheet.vue";

const props = defineProps<{ topUp: FundingTopUp }>();
const emit = defineEmits<FundingPackageEmits>();

const session = useSessionStore();
const opening = ref(true);
const unavailable = ref(false);
const waiting = computed(() => opening.value && session.lastState === null && !unavailable.value);
let active = true;

useVisibilityReconcile();
const { handedOff } = useMeldHandoff(emit);

const title = computed(
  () => fundingSelectorConfig.routes.find(({ id }) => id === props.topUp.route)?.label ?? "Status",
);
/** Whether the embed is showing: neither still opening nor unavailable. */
const showingWidget = computed(() => !waiting.value && !unavailable.value);
const canCancel = computed(
  () => showingWidget.value && !session.meldSubmitted && !session.fundsSeen,
);

async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
}

onMounted(async () => {
  const ref = meldRequestRef(props.topUp.id);
  const opened = ref === null ? false : await session.openRequest(ref);
  if (!active) {
    if (opened && !handedOff()) session.reset();
    return;
  }
  unavailable.value = !opened;
  opening.value = false;
});

onUnmounted(() => {
  active = false;
  // After a handoff the journey owns the request and resets it on its way out.
  if (!handedOff()) session.reset();
});
</script>

<template>
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-surface-main"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <!-- The title and page padding are dropped while the widget is up. -->
    <Toolbar
      :back="!waiting && !session.claiming"
      :title="showingWidget ? '' : title"
      @back="emit('back')"
    />

    <div class="flex min-h-0 flex-1 flex-col" :class="showingWidget ? '' : 'px-6 pt-6'">
      <div v-if="waiting" class="flex flex-col items-center gap-4 pt-16">
        <span
          class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-body-m text-fg-secondary">Opening your top-up…</p>
      </div>

      <div v-else-if="unavailable" class="flex flex-1 flex-col items-center pt-16 text-center">
        <h1 class="text-heading-l text-fg-primary">Top-up unavailable</h1>
        <p class="mt-2 text-body-m text-fg-secondary">
          This top-up is no longer available. Return to see your latest activity.
        </p>
      </div>

      <template v-else>
        <MeldPaySheet :pay-url="session.meldPayUrl" />
        <button
          v-if="canCancel"
          type="button"
          class="mx-6 mt-3 mb-4 h-12 shrink-0 rounded-medium bg-status-error text-label-l text-fg-primary-inverted transition-colors hover:bg-status-error-hover disabled:opacity-50"
          :disabled="session.cancelling"
          @click="cancelTopUp"
        >
          {{ session.cancelling ? "Cancelling…" : "Cancel" }}
        </button>
      </template>
    </div>
  </main>
</template>
