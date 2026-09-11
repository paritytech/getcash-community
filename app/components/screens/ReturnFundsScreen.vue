<script setup lang="ts">
// The return-funds guide behind a refunded deposit: the numbered path from gas to key to a wallet
// the buyer controls. The key is read on tap, never on load, and can be masked again after a look.
import { computed, ref, watch } from "vue";
import { Check, Copy, Eye, EyeClosed } from "lucide-vue-next";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { isRefundChain, type RefundKey } from "@getsome/ephemeral";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { useSessionStore } from "../../stores/session";
import { recoveryNotes, refundStatusTail } from "../../utils/recovery";
import PillButton from "../ui/PillButton.vue";

const emit = defineEmits<{ back: [] }>();
const session = useSessionStore();

const state = computed(() => session.lastState);
const failure = computed(() => (state.value?.phase === "failed" ? state.value.failure : null));
const refund = computed(() => (state.value?.phase === "failed" ? state.value.refund : undefined));
const source = computed(() => {
  const id = state.value?.sourceId;
  return id ? (SOURCE_CONFIG_BY_ID.get(id) ?? null) : null;
});
const asset = computed(() => source.value?.asset ?? "");
const chain = computed(() => {
  const c = source.value?.chain;
  return c !== undefined && isRefundChain(c) ? c : null;
});

/** "50 USDT" once the poll has sized the refund, the bare ticker before that. */
const subject = computed(() => {
  const s = source.value;
  const amount = refund.value?.amount;
  return s && amount ? `${formatSourceAmount(s, amount)} ${asset.value}` : asset.value;
});

const revealed = ref<RefundKey | null>(null);
const masked = ref(true);
function toggleKey() {
  if (!masked.value) {
    masked.value = true;
    return;
  }
  if (!revealed.value) revealed.value = session.revealRefundKey();
  if (revealed.value) masked.value = false;
}
// The preview deck lands on the shown key without a tap; the key still comes off the request's
// world, which the scene installs asynchronously (hence watching the address too). A changed
// address means another request took the screen: the held key is stale and is dropped.
watch(
  () => [session.refundAddress, session.revealRefund] as const,
  ([address, want], previous) => {
    if (previous && address !== previous[0]) {
      revealed.value = null;
      masked.value = true;
    }
    if (want && masked.value) toggleKey();
  },
  { immediate: true },
);

const notes = computed(() =>
  chain.value ? recoveryNotes(chain.value, asset.value, revealed.value?.format) : null,
);

/** Masked, the card shows stand-in dots: the secret is not even read until the eye is tapped. */
const keyText = computed(() =>
  revealed.value && !masked.value ? revealed.value.secret : "•".repeat(64),
);

/** The gas step leads only a token refund; a native one opens on where the coins landed. */
const steps = computed(() => {
  const n = notes.value;
  if (!n) return [];
  return [
    n.gasNote
      ? { text: n.gasNote, card: "address" as const }
      : { text: `Your ${asset.value} returns to this address.`, card: "address" as const },
    { text: n.importNote, card: "key" as const },
    { text: n.transferNote, card: null },
  ];
});

const { copied: addressCopied, copy: copyAddress } = useCopyToClipboard();
const { copied: keyCopied, copy: copyKey } = useCopyToClipboard();
</script>

<template>
  <section
    v-if="failure && notes"
    class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6"
    aria-label="Return funds"
  >
    <div class="flex shrink-0 flex-col gap-2 text-center">
      <h1 class="text-display-s text-fg-primary">Return funds</h1>
      <p class="text-paragraph-l text-fg-primary">
        <template v-if="failure.kind === 'refund-failed'">{{ failure.message }}</template>
        <template v-else>
          Your <span class="font-semibold">{{ subject }}</span> {{ refundStatusTail(refund) }}
        </template>
      </p>
    </div>

    <ol class="mt-8 flex shrink-0 flex-col gap-6">
      <li v-for="(step, index) in steps" :key="index" class="flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fg-primary text-heading-l text-fg-primary-inverted"
            aria-hidden="true"
          >
            {{ index + 1 }}
          </span>
          <p class="text-body-m text-fg-primary">{{ step.text }}</p>
        </div>

        <!-- The whole row copies the address; the icon confirms. -->
        <button
          v-if="step.card === 'address' && session.refundAddress"
          type="button"
          class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4 text-left"
          @click="copyAddress(session.refundAddress)"
        >
          <span class="min-w-0">
            <span class="block text-body-s text-fg-secondary">Address on {{ chain }}</span>
            <span class="mt-1 block break-all text-paragraph-l text-fg-primary">
              {{ session.refundAddress }}
            </span>
          </span>
          <Check v-if="addressCopied" class="size-6 shrink-0 text-fg-success" aria-hidden="true" />
          <Copy v-else class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
        </button>

        <div v-else-if="step.card === 'key'" class="flex flex-col gap-3">
          <div
            class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4"
          >
            <div class="min-w-0 flex-1">
              <p class="text-body-s text-fg-secondary">{{ notes.secretLabel }}</p>
              <div class="relative mt-1">
                <p class="break-all text-paragraph-l text-fg-primary" :aria-hidden="masked">
                  {{ keyText }}
                </p>
                <span
                  v-if="masked"
                  class="key-mask absolute -inset-1 rounded-nested"
                  aria-hidden="true"
                />
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-3">
              <button
                v-if="!masked && revealed"
                type="button"
                class="-m-2 p-2"
                aria-label="Copy the key"
                @click="copyKey(revealed.secret)"
              >
                <Check v-if="keyCopied" class="size-6 text-fg-success" aria-hidden="true" />
                <Copy v-else class="size-6 text-fg-secondary" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="-m-2 p-2"
                :aria-label="masked ? 'Show the key' : 'Hide the key'"
                :aria-pressed="!masked"
                @click="toggleKey"
              >
                <EyeClosed v-if="!masked" class="size-6 text-fg-secondary" aria-hidden="true" />
                <Eye v-else class="size-6 text-fg-secondary" aria-hidden="true" />
              </button>
            </div>
          </div>
          <p class="text-center text-body-s text-fg-error">
            Anyone with this key controls the funds. You can find it again in this transaction
          </p>
        </div>
      </li>
    </ol>

    <div class="mt-auto shrink-0 pt-8">
      <PillButton variant="tertiary" class="w-full" @click="emit('back')">Back</PillButton>
    </div>
  </section>
</template>

<style scoped>
/* The mask binds the black-alpha primitive: no semantic token covers a blurring scrim
 * (reported gap, like the journey hero's red). */
.key-mask {
  background: var(--palette-black-alpha-24);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
</style>
