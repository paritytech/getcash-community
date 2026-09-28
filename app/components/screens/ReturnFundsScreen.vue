<script setup lang="ts">
// The return-funds guide behind a refunded deposit: how far the refund has come, then the numbered
// path from gas to key to a wallet the buyer controls.
import { computed, ref, watch } from "vue";
import type { SourceId } from "@getsome/core";
import { ArrowUpRight, Check, Copy } from "lucide-vue-next";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { isRefundChain, type RefundKey } from "@getsome/ephemeral";
import { shortAddress } from "../../utils/address";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { effectiveSourceId, type RequestFailure } from "../../funding/requests/model";
import type { FundingTopUp } from "../../funding/top-ups";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { refundTxUrl } from "../../utils/explorer";
import { recoveryNotes, refundStatusTail } from "../../utils/recovery";
import RecoveryGuide, { type RecoveryStep } from "../ui/RecoveryGuide.vue";

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
const requests = useRequestsStore();

/** The failed request on screen; nothing to return while it stands. */
const record = computed(() => (requests.phase === "failed" ? requests.foregroundRecord : null));
/** The record's word on the failure, when no request is live to give one. */
const storedRefund = computed(() =>
  props.topUp?.state.kind === "failed" && props.topUp.state.refunded ? props.topUp.state : null,
);
const failure = computed<RequestFailure | null>(() => {
  const live = record.value?.failure;
  if (live) return live;
  const stored = storedRefund.value;
  // Reconstructed, not stored: the record keeps the reason, and `refunded` is what makes it this
  // failure rather than another. `recoverable` is false for every refund by construction.
  return stored === null
    ? null
    : { kind: "refunded", step: "swap", message: stored.reason ?? "", recoverable: false };
});
const refund = computed(() => {
  const live = record.value?.failure?.refund;
  if (live) return live;
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
  const r = record.value;
  const id = r
    ? (effectiveSourceId(r.ref) as SourceId)
    : (props.topUp?.request?.sourceId as SourceId | undefined);
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

/** The key once the guide has asked for it; its format names the secret. */
const revealed = ref<RefundKey | null>(null);
/**
 * The address to return to. The live world's while a request is on screen; otherwise the recovered
 * key's, which is the same address — both are the one derivation of (sourceId, tradeN).
 */
const recovered = ref<RefundKey | null>(null);
const address = computed(() => session.refundAddress ?? recovered.value?.address ?? null);
/** The key is still being derived, so the unavailable line waits. */
const recovering = ref(false);

// A refund opened from history has no world to read, so the key is re-derived from the request's
// own identity. The address is wanted on sight (it is where the money is); the secret stays behind
// the reveal either way.
//
// Watched as `sourceId:tradeN` rather than as the object: the list rebuilds its top-ups on every
// record tick, so while one is running the object's identity changes although which request this
// is has not — and re-deriving the key on each tick drops the address the screen is showing.
watch(
  () => {
    const r = props.topUp?.request;
    return r ? `${r.sourceId}:${r.tradeN}` : null;
  },
  async (key) => {
    recovered.value = null;
    const request = props.topUp?.request;
    if (key === null || !request || session.refundAddress !== null) return;
    recovering.value = true;
    try {
      recovered.value = await session.recoverRefundKeyFor(request.sourceId, request.tradeN);
    } finally {
      recovering.value = false;
    }
  },
  { immediate: true },
);

function revealKey(): string | null {
  if (!revealed.value) revealed.value = session.revealRefundKey() ?? recovered.value;
  return revealed.value?.secret ?? null;
}
// A changed address means another request took the screen: the held key is stale and is dropped,
// on the same address the guide masks its copy on.
watch(address, (next, previous) => {
  if (next !== previous) revealed.value = null;
});

const notes = computed(() =>
  chain.value ? recoveryNotes(chain.value, asset.value, revealed.value?.format) : null,
);

/** The gas step leads only a token refund; a native one opens on where the coins landed. */
const steps = computed<RecoveryStep[]>(() => {
  const n = notes.value;
  if (!n) return [];
  return [
    n.gasNote
      ? { text: n.gasNote, card: "address" }
      : { text: `Your ${asset.value} returns to this address.`, card: "address" },
    { text: n.importNote, card: "key" },
    { text: n.transferNote, card: null },
  ];
});

/**
 * Whether this request's recovery material could be reached at all.
 *
 * The live world has it outright; a refund opened from history re-derives it. Either can come up
 * empty — off-host there is no entropy root, and on-host the derivation can fail — and when it
 * does the buyer must be told, not handed a control that does nothing and a step pointing at an
 * address that was never drawn.
 */
const material = computed(() => address.value !== null || revealed.value !== null);

/** How far the refund has come, with its transaction split out so the screen can act on it. */
const status = computed(() => refundStatusTail(refund.value));
/** Where to watch it land. Null on a chain with no explorer mapped; the reference is still shown
 *  and still copyable, so the buyer can search for it themselves. */
const txUrl = computed(() => refundTxUrl(chain.value, status.value.txRef));

const { copied: txCopied, copy: copyTx } = useCopyToClipboard();
</script>

<template>
  <RecoveryGuide
    v-if="failure && notes"
    title="Refund info"
    :steps="steps"
    :address="address"
    :address-label="`Address on ${chain}`"
    :secret-label="notes.secretLabel"
    :reveal="revealKey"
    :material="material"
    :loading="recovering"
    :auto-reveal="session.revealRefund"
    @back="emit('back')"
  >
    <template #status>
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
    </template>
  </RecoveryGuide>
</template>
