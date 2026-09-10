<script setup lang="ts">
// Meld route for card and bank: pick the region, see the quote, then pay inside the provider's
// widget. Hands off to the journey once the payment is approved or fails.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useMeldHandoff } from "../../../composables/useMeldHandoff";
import { useStateDirector } from "../../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import { fundingSelectorConfig } from "../../../funding/config";
import { isDemoBuild } from "../../../utils/demo";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingSelection } from "../../../funding/selection";
import { useFlowStore } from "../../../stores/flow";
import { useSessionStore } from "../../../stores/session";
import MeldFeeDetailsScreen from "./MeldFeeDetailsScreen.vue";
import MeldPayScreen from "./MeldPayScreen.vue";
import MeldPaySheet from "./MeldPaySheet.vue";

const props = defineProps<{ selection: FundingSelection }>();
const emit = defineEmits<FundingPackageEmits>();

const route = props.selection.route;
if (route !== "card" && route !== "bank") {
  throw new Error(`Meld cannot handle the ${route} route`);
}

const session = useSessionStore();
const flow = useFlowStore();
useVisibilityReconcile();
const { previewLabel } = useStateDirector();
const { handedOff } = useMeldHandoff(emit);

const title = computed(
  () => fundingSelectorConfig.routes.find(({ id }) => id === route)?.label ?? route,
);
/** The fee-breakdown drill-in over the pay screen. Back (toolbar or bottom button) returns to it. */
const showingFees = ref(false);
// A cleared quote (re-quote, region change) leaves nothing to break down.
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
/** The widget stage: a request exists and the payment is still to be made. */
const paying = computed(() => flow.screen === "journey");
/** Cancel is offered only while nothing can have been paid. */
const canCancel = computed(
  () => paying.value && !session.meldSubmitted && !session.fundsSeen && !session.claiming,
);

/** Performs the cancel. One that went through leaves for the selector; a declined one stays put. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
}

/**
 * Demo Skip: the mock world fakes the deposit; the hosted demo funds the burner from the faucet.
 */
function onSkip() {
  if (session.mock) session.simulateDeposit();
  else void session.fundFaucet();
}

onMounted(() => {
  flow.startOver();
  session.setMethod(route);
  session.setAmount(props.selection.amount);
  // The bank route starts from a region that can quote it, until geolocation lands.
  if (route === "bank" && session.meldCountry === null) session.setMeldCountry("DE");
  void import("~~/lib/host-chain").then((hostChain) => hostChain.prewarmChains());
  void session.fetchMeldQuote();
});
onUnmounted(() => {
  // After a handoff only this package's entry state is reset.
  if (handedOff()) flow.resetEntry();
  else flow.startOver();
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
    <!-- No title while the widget is up; the back control stays. -->
    <Toolbar
      :title="paying ? '' : showingFees ? 'Fees' : title"
      :back="!session.claiming && !session.resuming"
      @back="goBack"
    >
      <template
        v-if="
          paying &&
          isDemoBuild() &&
          !session.claiming &&
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

    <!-- The screen padding is dropped while the widget is up. -->
    <div class="flex min-h-0 flex-1 flex-col" :class="paying ? '' : 'px-6 pt-6'">
      <div v-if="session.resuming" class="flex flex-col items-center gap-4 pt-16">
        <span
          class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-body-m text-fg-secondary">Opening your top-up…</p>
      </div>
      <template v-else-if="paying">
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
      <MeldFeeDetailsScreen v-else-if="showingFees" @back="showingFees = false" />
      <MeldPayScreen
        v-else
        @fees="showingFees = true"
        @switch-route="emit('switchRoute', $event)"
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
