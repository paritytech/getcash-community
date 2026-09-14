<script setup lang="ts">
// The journey route: the finish of a top-up from a confirmed deposit to CASH in the balance.
// Reached
// from a package's handoff or from a top-up opened from the list.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useStateDirector } from "../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../composables/useVisibilityReconcile";
import type { FundingJourneyStatus } from "../../funding/handoff";
import type { FundingTopUp } from "../../funding/top-ups";
import { useSessionStore } from "../../stores/session";
import FundingSettledStatusScreen from "./FundingSettledStatusScreen.vue";
import MeldFeeDetailsScreen from "./routes/MeldFeeDetailsScreen.vue";

const props = defineProps<{
  title: string;
  /** The top-up as the list knows it; null after a handoff. Its stored progress is the fallback
   *  while the request is not live in the store. */
  topUp?: FundingTopUp | null;
  /** Brings `topUp` to the foreground; null after a handoff. */
  open?: ((topUp: FundingTopUp) => Promise<boolean>) | null;
  status?: FundingJourneyStatus | null;
}>();
const emit = defineEmits<{ back: [] }>();

const session = useSessionStore();
// A settled top-up is read from the list only: nothing resumed, nothing reset on the way out.
const readOnly = props.topUp?.state.kind === "settled";
const opening = ref(!readOnly && props.topUp != null && props.open != null);
const unavailable = ref(false);
const waiting = computed(() => opening.value && session.lastState === null && !unavailable.value);
let active = true;

useVisibilityReconcile();
const { previewLabel } = useStateDirector();

/** The fee-breakdown drill-in over the journey. Back (toolbar or bottom button) returns to it. */
const showingFees = ref(false);
// A cleared quote leaves nothing to break down.
watch(
  () => session.quoted,
  (q) => {
    if (!q) showingFees.value = false;
  },
);
function goBack() {
  if (showingFees.value) showingFees.value = false;
  else emit("back");
}

onMounted(async () => {
  if (!opening.value || !props.topUp || !props.open) return;
  const opened = await props.open(props.topUp);
  if (!active) {
    if (opened) session.reset();
    return;
  }
  unavailable.value = !opened;
  opening.value = false;
});

onUnmounted(() => {
  active = false;
  if (!readOnly) session.reset();
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
    <!-- The live journey's toolbar is back-only; the fee drill-in takes it over while open.
         Back stays available during the claim: leaving lands on the top-ups list, where the
         in-flight top-up remains resumable. -->
    <Toolbar
      :title="showingFees ? 'Fees' : readOnly || waiting || unavailable ? title : ''"
      :back="readOnly || !waiting"
      @back="goBack"
    />

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <FundingSettledStatusScreen v-if="readOnly && topUp" :top-up="topUp" />

      <div v-else-if="waiting" class="flex flex-col items-center gap-4 pt-16">
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

      <MeldFeeDetailsScreen v-else-if="showingFees" @back="showingFees = false" />
      <JourneyScreen
        v-else
        :progress="topUp?.progress ?? null"
        :status="status ?? null"
        :top-up="topUp ?? null"
        @fees="showingFees = true"
        @close="emit('back')"
      />
    </div>

    <!-- state-director scene label (dev/demo keys only) -->
    <span
      v-if="previewLabel"
      class="fixed bottom-2 left-2 rounded-small bg-surface-container px-2 py-1 font-mono text-overline text-fg-secondary shadow-1"
    >
      {{ previewLabel }}
    </span>
  </main>
</template>
