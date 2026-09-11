<script setup lang="ts">
// A crypto top-up opened from the list while its deposit is still to be sent: brings the request to
// the foreground, shows where to send, and hands off once funds are seen.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { isDemoBuild } from "../../../utils/demo";
import { useChainflipHandoff } from "../../../composables/useChainflipHandoff";
import { useVisibilityReconcile } from "../../../composables/useVisibilityReconcile";
import { chainflipRequestRef } from "../../../funding/chainflip-top-ups";
import type { FundingPackageEmits } from "../../../funding/handoff";
import type { FundingTopUp } from "../../../funding/top-ups";
import { useFlowStore } from "../../../stores/flow";
import { useSessionStore } from "../../../stores/session";

const props = defineProps<{ topUp: FundingTopUp }>();
const emit = defineEmits<FundingPackageEmits>();

const session = useSessionStore();
const flow = useFlowStore();
const opening = ref(true);
const unavailable = ref(false);
const waiting = computed(() => opening.value && session.lastState === null && !unavailable.value);
let active = true;

useVisibilityReconcile();
const { handedOff } = useChainflipHandoff(emit);

/** A cancel that went through leaves for the list; a declined one returns to the deposit. */
async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
  else flow.confirmingCancel = false;
}

function onBack() {
  if (flow.confirmingCancel) flow.confirmingCancel = false;
  else emit("back");
}

function onDepositSkip() {
  if (session.mock) session.simulateDeposit();
  else void session.fundFaucet();
}

onMounted(async () => {
  const ref = chainflipRequestRef(props.topUp.id);
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
    <Toolbar
      :back="!waiting && !session.claiming"
      :title="flow.confirmingCancel ? undefined : 'Add funds via Crypto'"
      @back="onBack"
    >
      <template
        v-if="
          !waiting &&
          !unavailable &&
          !flow.confirmingCancel &&
          session.canSkipDeposit &&
          isDemoBuild()
        "
        #trailing
      >
        <button
          type="button"
          class="rounded-medium px-4 py-3 text-label-l font-normal text-fg-primary transition-colors hover:bg-action-tertiary-hover"
          @click="onDepositSkip"
        >
          Skip
        </button>
      </template>
    </Toolbar>

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <!-- While opening, the deposit screen renders its skeleton shapes (it has no deposit yet). -->
      <DepositScreen v-if="waiting" @cancel="cancelTopUp" />

      <div v-else-if="unavailable" class="flex flex-1 flex-col items-center pt-16 text-center">
        <h1 class="text-heading-l text-fg-primary">Top-up unavailable</h1>
        <p class="mt-2 text-body-m text-fg-secondary">
          This top-up is no longer available. Return to see your latest activity.
        </p>
      </div>

      <CancelTopUpScreen
        v-else-if="flow.confirmingCancel"
        @confirm="cancelTopUp"
        @keep="flow.confirmingCancel = false"
      />
      <DepositScreen v-else @cancel="flow.confirmingCancel = true" />
    </div>
  </main>
</template>
