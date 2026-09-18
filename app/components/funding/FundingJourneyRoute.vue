<script setup lang="ts">
// The journey route: the finish of a top-up from a confirmed deposit to CASH in the balance.
// Reached
// from a package's handoff or from a top-up opened from the list.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useStateDirector } from "../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../composables/useVisibilityReconcile";
import type { FundingJourneyStatus } from "../../funding/handoff";
import type { FundingTopUp } from "../../funding/top-ups";
import { useFlowStore } from "../../stores/flow";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import CancelTopUpScreen from "../screens/CancelTopUpScreen.vue";
import JourneySkeleton from "../screens/JourneySkeleton.vue";
import ReturnFundsScreen from "../screens/ReturnFundsScreen.vue";
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
// startOver bubbles up from a fiat top-up that ended: the host re-enters its package with the same
// amount. cancelled says the top-up is gone rather than left behind, so the host does not return
// to the screen it was opened from.
const emit = defineEmits<{ back: []; cancelled: []; startOver: [] }>();

const session = useSessionStore();
const requests = useRequestsStore();
const flow = useFlowStore();
// A settled top-up is read from the list only: nothing resumed, nothing reset on the way out.
const readOnly = props.topUp?.state.kind === "settled";
const opening = ref(!readOnly && props.topUp != null && props.open != null);
const unavailable = ref(false);
// Waiting on the record: this screen's own open, or a resume the store started under it (a
// reconcile on return from the background brings one back the same way).
const waiting = computed(
  () =>
    (opening.value || session.resuming) && requests.foregroundRecord === null && !unavailable.value,
);
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
/** The return-funds drill-in over a refunded journey. Back (toolbar or bottom button) returns. */
const showingRefund = ref(false);
// A state that is no longer failed has no refund to walk through.
watch(
  () => requests.phase,
  (phase) => {
    if (phase !== "failed") showingRefund.value = false;
  },
);
// The preview deck lands straight on the opened guide.
watch(
  () => session.revealRefund,
  (want) => {
    if (want) showingRefund.value = true;
  },
  { immediate: true },
);

// The cancel confirmation over the journey, asked for by the bank transfer's Cancel. It is the
// flow store's flag, as the crypto deposit's confirmation is: one place holds "a cancel is being
// confirmed", and the preview deck can stage it.
// A request past the point of cancelling takes the confirmation down with it: the money arrived
// while it was up, and the choice it offers is no longer there to make.
watch(
  () => requests.fundsSeen || requests.claiming,
  (paid) => {
    if (paid) flow.confirmingCancel = false;
  },
);

function goBack() {
  if (flow.confirmingCancel) flow.confirmingCancel = false;
  else if (showingRefund.value) showingRefund.value = false;
  else if (showingFees.value) showingFees.value = false;
  else emit("back");
}

/** Performs the cancel. One that went through hands the screen back to the shell — there is no
 *  top-up left to return to; a declined one returns to the journey, where the store's notice says
 *  why. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("cancelled");
  else flow.confirmingCancel = false;
}

onMounted(async () => {
  if (!opening.value || !props.topUp || !props.open) return;
  let opened = false;
  try {
    opened = await props.open(props.topUp);
  } catch (e) {
    console.warn("[funding] could not open the top-up:", e);
    opened = false;
  } finally {
    if (active) {
      unavailable.value = !opened;
      opening.value = false;
    }
  }
  if (!active && opened) session.reset();
});

onUnmounted(() => {
  active = false;
  // The confirmation belongs to this screen; leaving must not carry it to the next one.
  flow.confirmingCancel = false;
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
      :back="(readOnly || !waiting) && !session.cancelling"
      @back="goBack"
    />

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <FundingSettledStatusScreen v-if="readOnly && topUp" :top-up="topUp" />

      <!-- The screen's own shapes while the request opens, not a spinner over an empty one. -->
      <JourneySkeleton v-else-if="waiting" :timeline="!readOnly" />

      <div v-else-if="unavailable" class="flex flex-1 flex-col items-center pt-16 text-center">
        <h1 class="text-heading-l text-fg-primary">Top-up unavailable</h1>
        <p class="mt-2 text-body-m text-fg-secondary">
          This top-up is no longer available. Return to see your latest activity.
        </p>
      </div>

      <CancelTopUpScreen
        v-else-if="flow.confirmingCancel"
        kind="transfer"
        @confirm="cancelTopUp"
        @keep="flow.confirmingCancel = false"
      />
      <ReturnFundsScreen v-else-if="showingRefund" @back="showingRefund = false" />
      <MeldFeeDetailsScreen v-else-if="showingFees" @back="showingFees = false" />
      <template v-else>
        <JourneyScreen
          :progress="topUp?.progress ?? null"
          :status="status ?? null"
          :top-up="topUp ?? null"
          @fees="showingFees = true"
          @refund="showingRefund = true"
          @cancel="flow.confirmingCancel = true"
          @close="emit('back')"
          @start-over="emit('startOver')"
        />
        <!-- A cancel the adapter refused: the payment is already on its way and the request
             stands. -->
        <p
          v-if="session.cancelNotice"
          class="shrink-0 pb-6 text-center text-body-m text-fg-secondary"
          role="status"
        >
          {{ session.cancelNotice }}
        </p>
      </template>
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
