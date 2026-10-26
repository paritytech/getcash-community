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
import RateErrorScreen from "../../ui/RateErrorScreen.vue";

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

/** A price that could not be had takes the pickers' place, in the two steps every quote screen
 *  shows: a retry, then a change of amount. The rail cannot be swapped for itself. */
const quoteFailed = computed(
  () => flow.screen === "entry" && session.quoteError !== null && !session.loading,
);

const toolbar = computed<{
  back: boolean;
  title?: string;
  trailing: "skip" | null;
}>(() => {
  if (session.resuming) return { back: false, title: "Top up via crypto", trailing: null };
  // The confirmation and the recovery guide carry only the way back to the deposit.
  if (flow.confirmingCancel || flow.recoveringDeposit) return { back: true, trailing: null };
  // "journey" here is the deposit stage: the request exists and funds are still to be seen.
  if (flow.screen === "journey") {
    return {
      back: !requests.claiming,
      title: "Top up via crypto",
      trailing: session.canSkipDeposit && !requests.claiming && isDemoBuild() ? "skip" : null,
    };
  }
  // The failed quote takes the pickers' place; the title names the action it failed.
  if (quoteFailed.value) return { back: true, title: "Add funds via Crypto", trailing: null };
  return {
    back: true,
    title: flow.step === "token" ? "Select token" : "Select network",
    trailing: null,
  };
});

function onBack() {
  if (flow.confirmingCancel || flow.recoveringDeposit) {
    flow.confirmingCancel = false;
    flow.recoveringDeposit = false;
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

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <!-- Resuming renders the deposit screen's skeleton shapes until the request is live. -->
      <DepositScreen v-if="session.resuming" @cancel="flow.confirmingCancel = true" />
      <RateErrorScreen
        v-else-if="quoteFailed"
        :failures="session.quoteFailures"
        :crypto="false"
        @retry="requote"
        @change-amount="emit('changeAmount')"
      />
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
