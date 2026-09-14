<script setup lang="ts">
// The way back to a refunded deposit: the refund's status line, and the key controlling the
// address the funds return to.
import { computed, ref } from "vue";
import type { PaymentFailure, RefundProgress } from "@getsome/core";
import type { RefundKey } from "@getsome/ephemeral";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { useSessionStore } from "../../stores/session";
import { recoveryNotes } from "../../utils/recovery";
import PillButton from "../ui/PillButton.vue";
import SecondaryButton from "../ui/SecondaryButton.vue";

const props = defineProps<{
  failure: PaymentFailure;
  /** The refund as far as the status poll has seen it. */
  refund?: RefundProgress;
  /** The deposit's asset ticker, e.g. "BTC". */
  asset: string;
}>();
const session = useSessionStore();

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a);
const refundStatus = computed(() => {
  if (props.failure.kind === "refund-failed") return props.failure.message;
  if (props.refund?.witnessedAt) return `Your ${props.asset} is back at the address below.`;
  if (props.refund?.txRef) {
    return `Your ${props.asset} is on its way back, transaction ${short(props.refund.txRef)}.`;
  }
  return `Your ${props.asset} is being returned to the address below.`;
});

/** The key is read on tap, never on load, and stays masked until tapped again. */
const revealed = ref<RefundKey | null>(null);
const notes = computed(() => (revealed.value ? recoveryNotes(revealed.value, props.asset) : null));
function reveal() {
  revealed.value = session.revealRefundKey();
}
const secretShown = ref(false);

const { copied, copy } = useCopyToClipboard();
</script>

<template>
  <p class="text-body-m text-fg-secondary">{{ refundStatus }}</p>
  <div v-if="revealed && notes" class="flex flex-col gap-4">
    <dl class="flex flex-col gap-3">
      <div>
        <dt class="text-body-m text-fg-secondary">Address on {{ revealed.chain }}</dt>
        <dd class="font-mono text-body-m break-all">{{ revealed.address }}</dd>
      </div>
      <div>
        <dt class="text-body-m text-fg-secondary">{{ notes.secretLabel }}</dt>
        <dd>
          <button
            type="button"
            class="w-full text-left font-mono text-body-m break-all"
            :aria-pressed="secretShown"
            @click="secretShown = !secretShown"
          >
            <template v-if="secretShown">{{ revealed.secret }}</template>
            <template v-else>
              <span aria-hidden="true">••••••••••••••••••••••••</span>
              <span class="ml-2 font-sans text-fg-secondary">Tap to show</span>
            </template>
          </button>
        </dd>
      </div>
    </dl>
    <SecondaryButton class="self-start" @click="revealed && copy(revealed.secret)">
      {{ copied ? "Copied" : "Copy key" }}
    </SecondaryButton>
    <p v-if="notes.gasNote" class="text-body-m text-fg-secondary">
      {{ notes.gasNote }}
    </p>
    <p class="text-body-m text-fg-error">
      Anyone with this key controls the funds. Import it into a wallet and move them.
    </p>
  </div>
  <PillButton v-else @click="reveal">Get your funds back</PillButton>
</template>
