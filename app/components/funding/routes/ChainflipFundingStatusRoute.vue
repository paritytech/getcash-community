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
import { useSessionStore } from "../../../stores/session";

const props = defineProps<{ topUp: FundingTopUp }>();
const emit = defineEmits<FundingPackageEmits>();

const session = useSessionStore();
const opening = ref(true);
const unavailable = ref(false);
const waiting = computed(() => opening.value && session.lastState === null && !unavailable.value);
let active = true;

useVisibilityReconcile();
const { handedOff } = useChainflipHandoff(emit);

async function cancelTopUp() {
  if (await session.cancelTopUp()) emit("back");
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
  // After a handoff the journey owns the request and resets it on its way out.
  if (!handedOff()) session.reset();
});
</script>

<template>
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-bg"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <Toolbar :back="!waiting && !session.claiming" title="Crypto" @back="emit('back')">
      <template
        v-if="!waiting && !unavailable && session.canSkipDeposit && isDemoBuild()"
        #trailing
      >
        <button
          type="button"
          class="px-4 py-3 text-base leading-6 font-semibold text-text-primary"
          @click="onDepositSkip"
        >
          Skip
        </button>
      </template>
    </Toolbar>

    <div class="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <div v-if="waiting" class="flex flex-col items-center gap-4 pt-16">
        <span
          class="inline-block size-8 animate-spin rounded-full border-[3px] border-track border-t-white"
        />
        <p class="text-sm text-text-secondary">Opening your top-up…</p>
      </div>

      <div v-else-if="unavailable" class="flex flex-1 flex-col items-center pt-16 text-center">
        <h1 class="text-lg font-semibold">Top-up unavailable</h1>
        <p class="mt-2 text-sm text-text-secondary">
          This top-up is no longer available. Return to see your latest activity.
        </p>
      </div>

      <DepositScreen v-else @cancel="cancelTopUp" />
    </div>
  </main>
</template>
