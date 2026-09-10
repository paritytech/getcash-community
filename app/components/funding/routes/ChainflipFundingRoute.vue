<script setup lang="ts">
// Chainflip route: pick network and token, then show where to send until the deposit is seen. Hands
// off to the journey once funds are seen or the deposit window lapses.
import { computed, onMounted, onUnmounted } from "vue";
import { isDemoBuild } from "../../../utils/demo";
import { useChainflipHandoff } from "../../../composables/useChainflipHandoff";
import { useStateDirector } from "../../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingSelection } from "../../../funding/selection";
import { useFlowStore } from "../../../stores/flow";
import { useOffersStore } from "../../../stores/offers";
import { useSessionStore } from "../../../stores/session";

const props = defineProps<{ selection: FundingSelection }>();
const emit = defineEmits<FundingPackageEmits>();

if (props.selection.route !== "crypto") {
  throw new Error(`Chainflip cannot handle the ${props.selection.route} route`);
}

const session = useSessionStore();
const flow = useFlowStore();
const offers = useOffersStore();
useVisibilityReconcile();
const { previewLabel } = useStateDirector();
const { handedOff } = useChainflipHandoff(emit);

const toolbar = computed<{
  back: boolean;
  title?: string;
  trailing: "skip" | null;
}>(() => {
  if (session.resuming) return { back: false, title: "Crypto", trailing: null };
  // "journey" here is the deposit stage: the request exists and funds are still to be seen.
  if (flow.screen === "journey") {
    return {
      back: !session.claiming,
      title: "Crypto",
      trailing: session.canSkipDeposit && !session.claiming && isDemoBuild() ? "skip" : null,
    };
  }
  return {
    back: true,
    title: flow.step === "token" ? "Select coin to pay" : "Select network",
    trailing: null,
  };
});

function onBack() {
  if (
    flow.screen === "journey" ||
    flow.step === "network" ||
    flow.step === "method" ||
    flow.step === "amount"
  )
    emit("back");
  else flow.back();
}

/** Performs the cancel. One that went through leaves for the selector; a declined one stays put. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
}

/**
 * Demo Skip: the mock world fakes the deposit, the live demo funds the ephemeral from the faucet.
 */
function onDepositSkip() {
  if (session.mock) session.simulateDeposit();
  else void session.fundFaucet();
}

let active = true;
onMounted(async () => {
  flow.startOver();
  session.setAmount(props.selection.amount);
  flow.step = "network";
  void import("~~/lib/host-chain").then((hostChain) => hostChain.prewarmChains());
  if (!active) return;
  // Open requests carry on converting; none of them takes the screen.
  void session.resumeOpenRequests();
  // Learn which crypto sources can serve the selected amount.
  void offers.learn();
  void session.fetchQuote(flow.srcChain.chain, flow.srcAsset);
});
onUnmounted(() => {
  active = false;
  // After a handoff only this package's entry choices are reset; before one the whole flow starts
  // over.
  if (handedOff()) flow.resetEntry();
  else flow.startOver();
});
</script>

<template>
  <!-- Toolbar and screen fill the visible viewport; the app never scrolls. -->
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-surface-main"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <Toolbar :title="toolbar.title" :back="toolbar.back" @back="onBack">
      <template v-if="toolbar.trailing" #trailing>
        <button
          v-if="toolbar.trailing === 'skip'"
          type="button"
          class="rounded-medium px-4 py-3 text-label-l font-normal text-fg-primary transition-colors hover:bg-action-tertiary-hover"
          @click="onDepositSkip"
        >
          Skip
        </button>
      </template>
    </Toolbar>

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <!-- Resuming renders the deposit screen's skeleton shapes until the request is live. -->
      <DepositScreen v-if="session.resuming" @cancel="cancelTopUp" />
      <template v-else>
        <DepositScreen v-if="flow.screen === 'journey'" @cancel="cancelTopUp" />
        <NetworkScreen
          v-else-if="flow.step === 'network' || flow.step === 'amount' || flow.step === 'method'"
          @change-amount="emit('back')"
        />
        <TokenScreen v-else />
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
