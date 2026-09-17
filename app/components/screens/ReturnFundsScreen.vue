<script setup lang="ts">
// The return-funds guide behind a refunded deposit: the numbered path from gas to key to a wallet
// the buyer controls. The key is read on tap, never on load, and can be masked again after a look.
import { computed, ref, watch } from "vue";
import type { SourceId } from "@getsome/core";
import { ArrowUpRight, Check, Copy, Eye, EyeClosed } from "lucide-vue-next";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { isRefundChain, type RefundKey } from "@getsome/ephemeral";
import { shortAddress } from "../../utils/address";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import type { FundingTopUp } from "../../funding/top-ups";
import { useSessionStore } from "../../stores/session";
import { refundTxUrl } from "../../utils/explorer";
import { recoveryNotes, refundStatusTail } from "../../utils/recovery";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{
  /**
   * The top-up as the list knows it, for a refund opened out of history. Everything below reads
   * the live request first and falls back to this: the world is gone on that path, and the record
   * is then the only account of the refund there is.
   */
  topUp?: FundingTopUp | null;
}>();
const emit = defineEmits<{ back: [] }>();
const session = useSessionStore();

const state = computed(() => session.lastState);
/** The record's word on the failure, when no request is live to give one. */
const storedRefund = computed(() =>
  props.topUp?.state.kind === "failed" && props.topUp.state.refunded ? props.topUp.state : null,
);
const failure = computed(() => {
  if (state.value?.phase === "failed") return state.value.failure;
  const stored = storedRefund.value;
  // Reconstructed, not stored: the record keeps the reason, and `refunded` is what makes it this
  // failure rather than another. `recoverable` is false for every refund by construction.
  return stored === null
    ? null
    : {
        kind: "refunded" as const,
        step: "swap" as const,
        message: stored.reason ?? "",
        recoverable: false,
      };
});
const refund = computed(() => {
  if (state.value?.phase === "failed") return state.value.refund;
  const stored = storedRefund.value;
  if (stored === null) return undefined;
  return {
    ...(stored.refundAmount ? { amount: stored.refundAmount } : {}),
    ...(stored.refundTxRef ? { txRef: stored.refundTxRef } : {}),
  };
});
const source = computed(() => {
  // The record's source id is a plain string; a lookup miss is the same "no source" the live path
  // already handles, so an id the registry does not know simply yields nothing.
  const id = state.value?.sourceId ?? (props.topUp?.request?.sourceId as SourceId | undefined);
  return id ? (SOURCE_CONFIG_BY_ID.get(id) ?? null) : null;
});
const asset = computed(() => source.value?.asset ?? "");
const chain = computed(() => {
  const c = source.value?.chain;
  return c !== undefined && isRefundChain(c) ? c : null;
});

/**
 * "50 USDT" once the poll has sized the refund, the bare ticker before that.
 *
 * The amount is base units and may have come off a record written by an older build, so a value
 * `formatSourceAmount` cannot parse falls back to the ticker. This is the screen that tells a
 * buyer where their money is; a malformed figure must not be able to take it down.
 */
const subject = computed(() => {
  const s = source.value;
  const amount = refund.value?.amount;
  if (!s || !amount) return asset.value;
  try {
    return `${formatSourceAmount(s, amount)} ${asset.value}`;
  } catch {
    console.warn(`[refund] unreadable refund amount '${amount}' for ${s.asset}`);
    return asset.value;
  }
});

const revealed = ref<RefundKey | null>(null);
const masked = ref(true);
/**
 * The address to return to. The live world's while a request is on screen; otherwise the recovered
 * key's, which is the same address — both are the one derivation of (sourceId, tradeN).
 */
const recovered = ref<RefundKey | null>(null);
const address = computed(() => session.refundAddress ?? recovered.value?.address ?? null);

// A refund opened from history has no world to read, so the key is re-derived from the request's
// own identity. The address is wanted on sight (it is where the money is); the secret stays behind
// the reveal either way.
watch(
  () => props.topUp?.request,
  async (request) => {
    recovered.value = null;
    if (!request || session.refundAddress !== null) return;
    recovering.value = true;
    try {
      recovered.value = await session.recoverRefundKeyFor(request.sourceId, request.tradeN);
    } finally {
      recovering.value = false;
    }
  },
  { immediate: true },
);

async function toggleKey() {
  if (!masked.value) {
    masked.value = true;
    return;
  }
  if (!revealed.value) revealed.value = session.revealRefundKey() ?? recovered.value;
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

/**
 * Whether this request's recovery material could be reached at all.
 *
 * The live world has it outright; a refund opened from history re-derives it. Either can come up
 * empty — off-host there is no entropy root, and on-host the derivation can fail — and when it
 * does the buyer must be told, not handed a control that does nothing and a step pointing at an
 * address that was never drawn. `recovering` keeps that message off the screen while the
 * derivation is still in flight.
 */
const recovering = ref(false);
const material = computed(() => address.value !== null || revealed.value !== null);

/** How far the refund has come, with its transaction split out so the screen can act on it. */
const status = computed(() => refundStatusTail(refund.value));
/** Where to watch it land. Null on a chain with no explorer mapped; the reference is still shown
 *  and still copyable, so the buyer can search for it themselves. */
const txUrl = computed(() => refundTxUrl(chain.value, status.value.txRef));

const { copied: addressCopied, copy: copyAddress } = useCopyToClipboard();
const { copied: keyCopied, copy: copyKey } = useCopyToClipboard();
const { copied: txCopied, copy: copyTx } = useCopyToClipboard();
</script>

<template>
  <section
    v-if="failure && notes"
    class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6"
    aria-label="Refund info"
  >
    <div class="flex shrink-0 flex-col gap-2 text-center">
      <h1 class="text-display-s text-fg-primary">Refund info</h1>
      <p class="text-paragraph-l text-fg-primary">
        <template v-if="failure.kind === 'refund-failed'">{{ failure.message }}</template>
        <template v-else>
          Your <span class="font-semibold">{{ subject }}</span> {{ status.text }}
          <!-- The reference is the buyer's handle on the money in flight: it opens on the chain's
               explorer, and copies whether or not one is mapped. -->
          <template v-if="status.txRef">
            <!-- The arrow sits inside the underline, as the design draws it: one target, not a
                 word with a symbol loose beside it. -->
            <a
              v-if="txUrl"
              :href="txUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="whitespace-nowrap underline decoration-1 underline-offset-4"
            >
              {{ shortAddress(status.txRef)
              }}<ArrowUpRight class="ml-0.5 inline size-[1em] align-baseline" aria-hidden="true" />
            </a>
            <span v-else>{{ shortAddress(status.txRef) }}</span>
            <!-- Padded to a thumb, with the padding pulled back out of the line box so it does
                 not open up the sentence's leading. -->
            <button
              type="button"
              class="-my-2 ml-1 inline-flex items-center p-2 align-middle"
              aria-label="Copy the transaction"
              @click="copyTx(status.txRef)"
            >
              <Check v-if="txCopied" class="size-5 text-fg-success" aria-hidden="true" />
              <Copy v-else class="size-5 text-fg-secondary" aria-hidden="true" />
            </button>
          </template>
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
          v-if="step.card === 'address' && address"
          type="button"
          class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4 text-left"
          @click="copyAddress(address)"
        >
          <span class="min-w-0">
            <span class="block text-body-s text-fg-secondary">Address on {{ chain }}</span>
            <span class="mt-1 block break-all text-paragraph-l text-fg-primary">
              {{ address }}
            </span>
          </span>
          <Check v-if="addressCopied" class="size-6 shrink-0 text-fg-success" aria-hidden="true" />
          <Copy v-else class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
        </button>

        <div v-else-if="step.card === 'key' && material" class="flex flex-col gap-3">
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
            Anyone with this key controls the funds.
          </p>
        </div>
      </li>
    </ol>

    <!-- Nothing to hand over. Said once, under the steps, rather than leaving each of them to
         trail off into a card that never appears. -->
    <p v-if="!material && !recovering" class="mt-6 shrink-0 text-center text-body-m text-fg-error">
      Your recovery address and key can't be loaded on this device. Open this top-up in the Polkadot
      App to reach them.
    </p>

    <div class="mt-auto shrink-0 pt-8">
      <CopiedPill />
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
