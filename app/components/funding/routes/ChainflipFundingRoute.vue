<script setup lang="ts">
// Chainflip route: pick network and token, then show where to send until the deposit is seen. Hands
// off to the journey once funds are seen or the deposit window lapses.
import { computed, onMounted, onUnmounted } from "vue";
import { isDemoBuild } from "../../../utils/demo";
import { previewStage } from "../../../utils/dev-preview-stage";
import { useChainflipHandoff } from "../../../composables/useChainflipHandoff";
import { useStateDirector } from "../../../composables/useStateDirector";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingSelection } from "../../../funding/selection";
import { useFlowStore } from "../../../stores/flow";
import { useRequestsStore } from "../../../stores/requests";
import { useSessionStore } from "../../../stores/session";

const props = defineProps<{ selection: FundingSelection }>();
const emit = defineEmits<FundingPackageEmits>();

if (props.selection.route !== "crypto") {
  throw new Error(`Chainflip cannot handle the ${props.selection.route} route`);
}

const session = useSessionStore();
const requests = useRequestsStore();
const flow = useFlowStore();
useVisibilityReconcile();
useStateDirector();
const { handedOff } = useChainflipHandoff(emit);

const toolbar = computed<{
  back: boolean;
  title?: string;
  trailing: "skip" | null;
}>(() => {
  if (session.resuming) return { back: false, title: "Add funds via Crypto", trailing: null };
  // The confirmation carries only the way back to the deposit.
  if (flow.confirmingCancel) return { back: true, trailing: null };
  // "journey" here is the deposit stage: the request exists and funds are still to be seen.
  if (flow.screen === "journey") {
    return {
      back: !requests.claiming,
      title: "Add funds via Crypto",
      trailing: session.canSkipDeposit && !requests.claiming && isDemoBuild() ? "skip" : null,
    };
  }
  return {
    back: true,
    title: flow.step === "token" ? "Select token" : "Select network",
    trailing: null,
  };
});

function onBack() {
  if (flow.confirmingCancel) {
    flow.confirmingCancel = false;
    return;
  }
  if (
    flow.screen === "journey" ||
    flow.step === "network" ||
    flow.step === "method" ||
    flow.step === "amount"
  )
    emit("back");
  else flow.back();
}

/** Performs the cancel. One that went through leaves for the selector; a declined one returns to
 *  the deposit. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
  else flow.confirmingCancel = false;
}

/**
 * Demo Skip: the mock world fakes the deposit, the live demo funds the ephemeral from the faucet.
 */
function onDepositSkip() {
  if (session.mock) session.simulateDeposit();
  else void session.fundFaucet();
}

/** Shows a failed quote on the pickers with a way to ask again. */
const quoteFailed = computed(
  () => flow.screen === "entry" && session.quoteError !== null && !session.loading,
);
function requote() {
  void session.fetchQuote(flow.srcChain.chain, flow.srcAsset);
}

let active = true;
onMounted(async () => {
  // The preview deck put this package on screen for a scene that owns the store state; its own
  // entry — a fresh flow, a re-quote, a floor sweep — would land on top of what the scene wrote.
  if (previewStage.value?.kind === "package") return;
  flow.startOver();
  session.setAmount(props.selection.amount);
  flow.step = "network";
  void import("~~/lib/host-chain").then((hostChain) => hostChain.prewarmChains());
  if (!active) return;
  // Open requests carry on converting; none of them takes the screen. The pickers learn which
  // crypto sources can serve the amount, and keep that fresh, while they are on screen.
  void session.resumeOpenRequests();
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

    <!-- Why there is no quote, on a card. -->
    <div
      v-if="quoteFailed"
      class="mx-6 mt-6 flex shrink-0 flex-col gap-3 rounded-container bg-surface-container p-4 shadow-1"
    >
      <p class="text-body-m text-fg-error">Couldn't price this top-up: {{ session.quoteError }}</p>
      <SecondaryButton class="self-start" @click="requote">Try again</SecondaryButton>
    </div>

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <!-- Resuming renders the deposit screen's skeleton shapes until the request is live. -->
      <DepositScreen v-if="session.resuming" @cancel="flow.confirmingCancel = true" />
      <template v-else>
        <CancelTopUpScreen
          v-if="flow.screen === 'journey' && flow.confirmingCancel"
          @confirm="cancelTopUp"
          @keep="flow.confirmingCancel = false"
        />
        <DepositScreen
          v-else-if="flow.screen === 'journey'"
          @cancel="flow.confirmingCancel = true"
        />
        <NetworkScreen
          v-else-if="flow.step === 'network' || flow.step === 'amount' || flow.step === 'method'"
        />
        <TokenScreen v-else />
      </template>
    </div>

    <!-- state-director scene label (dev/demo keys only) -->
    <PreviewSceneLabel />
  </main>
</template>
