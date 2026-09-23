<script setup lang="ts">
// A fiat top-up opened from the list while its payment is still to be made: brings the request to
// the foreground, shows the buyer what is left to do, and hands off once the payment is approved.
//
// The two rails need different screens here, because the payment is made in different places. A
// card is paid inside the provider's widget, which reports the payment itself. A bank transfer is
// paid in the buyer's own banking app, from details the provider's page only displays — nothing
// can observe it, so the transfer's own screen and its "I've sent funds" is the only way forward.
// Showing the widget for both left a re-opened transfer with no way to say it had been sent, and
// an unconfirmed request expires on the clock while the money is still in the post.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useJourneyQuote } from "../../../composables/useJourneyQuote";
import { useMeldHandoff } from "../../../composables/useMeldHandoff";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import { isDemoBuild } from "../../../utils/demo";
import { fundingSelectorConfig } from "../../../funding/config";
import type { FundingPackageEmits } from "../../../funding/handoff";
import { meldRequestRef } from "../../../funding/meld-top-ups";
import type { FundingTopUp } from "../../../funding/top-ups";
import { useFlowStore } from "../../../stores/flow";
import { useRequestsStore } from "../../../stores/requests";
import { useSessionStore } from "../../../stores/session";
import CancelTopUpScreen from "../../screens/CancelTopUpScreen.vue";
import MeldBankTransferScreen from "./MeldBankTransferScreen.vue";
import MeldFeeDetailsScreen from "./MeldFeeDetailsScreen.vue";
import MeldPaySheet from "./MeldPaySheet.vue";

const props = defineProps<{ topUp: FundingTopUp }>();
const emit = defineEmits<FundingPackageEmits>();

const session = useSessionStore();
const requests = useRequestsStore();
const flow = useFlowStore();
const opening = ref(true);
const unavailable = ref(false);
const waiting = computed(
  () => opening.value && requests.foregroundRecord === null && !unavailable.value,
);
let active = true;

useVisibilityReconcile();
const { handedOff } = useMeldHandoff(emit);

const isBank = props.topUp.route === "bank";
/** The bank route's screens are titled in lower case, as the design writes them. */
const title = computed(() => {
  if (isBank) return "Add funds via bank";
  const label = fundingSelectorConfig.routes.find(({ id }) => id === props.topUp.route)?.label;
  return label ? `Add funds via ${label}` : "Status";
});
/** The fee-breakdown drill-in over the transfer's details. Back returns to them. */
const showingFees = ref(false);
// The quote behind the breakdown: the restored live one, else the row's stored copy.
const { quote, cashAmount } = useJourneyQuote(() => props.topUp);
/** Whether the payment screen is showing: neither still opening nor unavailable. */
const showingPayment = computed(() => !waiting.value && !unavailable.value);
/** Edge to edge for the card widget only; the transfer's details take the screen's own gutter. */
const showingWidget = computed(() => showingPayment.value && !isBank);
const canCancel = computed(
  () => showingPayment.value && !requests.meldSubmitted && !requests.fundsSeen,
);

/** The region the transfer was priced in, restored with the request. */
const country = computed(() => session.meldCountry ?? "DE");

function goBack() {
  if (flow.confirmingCancel) flow.confirmingCancel = false;
  else if (showingFees.value) showingFees.value = false;
  else emit("back");
}

/**
 * Performs the cancel. One that went through leaves for the list the row was opened from; a
 * declined one returns to the screen, where the store's notice says why.
 */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
  else flow.confirmingCancel = false;
}

/**
 * Demo Skip: the mock world fakes the deposit; the hosted demo funds the burner from the faucet.
 */
function onSkip() {
  if (session.mock) session.simulateDeposit();
  else void session.fundFaucet();
}

onMounted(async () => {
  const ref = meldRequestRef(props.topUp.id);
  let opened = false;
  try {
    opened = ref === null ? false : await session.openRequest(ref);
  } catch (e) {
    console.warn("[funding] could not open the top-up:", e);
    opened = false;
  } finally {
    if (active) {
      unavailable.value = !opened;
      opening.value = false;
    }
  }
  if (!active && opened && !handedOff()) session.reset();
});

onUnmounted(() => {
  active = false;
  // The confirmation belongs to this screen; leaving must not carry it to the next one.
  flow.confirmingCancel = false;
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
    <!-- The title and page padding are dropped while the card widget is up. -->
    <Toolbar
      :back="!waiting && !requests.claiming && !session.cancelling"
      :title="flow.confirmingCancel ? '' : showingFees ? 'Fees' : showingWidget ? '' : title"
      @back="goBack"
    >
      <template
        v-if="
          showingPayment &&
          !showingFees &&
          isDemoBuild() &&
          !requests.claiming &&
          (session.canSkipDeposit || session.faucetState !== 'idle')
        "
        #trailing
      >
        <!-- Skip hides once tapped; a spinner takes its place until the deposit is seen. -->
        <button
          v-if="session.canSkipDeposit"
          type="button"
          class="rounded-medium px-4 py-3 text-label-l font-normal text-fg-primary transition-colors hover:bg-action-tertiary-hover"
          @click="onSkip"
        >
          Skip
        </button>
        <span
          v-else
          class="mx-4 my-3 inline-block size-6 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
      </template>
    </Toolbar>

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

      <!-- The transfer may already be on its way and nothing here can see it, so the choice gets
           the whole screen, exactly as it does on the journey. -->
      <CancelTopUpScreen
        v-else-if="flow.confirmingCancel"
        kind="transfer"
        @confirm="cancelTopUp"
        @keep="flow.confirmingCancel = false"
      />

      <MeldFeeDetailsScreen
        v-else-if="showingFees"
        :quote="quote"
        :cash-amount="cashAmount"
        @back="showingFees = false"
      />

      <!-- The transfer's own details step, the same screen the fresh flow ends on, with the way
           out that only a resumed transfer needs. -->
      <MeldBankTransferScreen
        v-else-if="isBank"
        :country="country"
        step="details"
        :cancellable="canCancel"
        @fees="showingFees = true"
        @cancel="flow.confirmingCancel = true"
        @leave="emit('back')"
      />

      <template v-else>
        <MeldPaySheet :pay-url="session.meldPayUrl" />
        <!-- No confirmation on the card: its charge is reported by the widget itself, so a
             payment we cannot see is not a state this rail reaches. -->
        <button
          v-if="canCancel"
          type="button"
          class="mx-6 mt-3 mb-4 h-12 shrink-0 rounded-medium bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
          :disabled="session.cancelling || !session.cancelReady"
          @click="cancelTopUp"
        >
          {{ session.cancelling ? "Cancelling…" : "Cancel" }}
        </button>
        <p
          v-if="session.cancelNotice"
          class="mx-6 mb-4 text-center text-body-m text-fg-secondary"
          role="status"
        >
          {{ session.cancelNotice }}
        </p>
      </template>
    </div>
  </main>
</template>
