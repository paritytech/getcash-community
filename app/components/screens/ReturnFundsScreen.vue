<script setup lang="ts">
// The return-funds guide behind a refunded deposit: the numbered path from gas to key to a wallet
// the buyer controls. The key is read on tap, never on load, and can be masked again after a look.
import { computed } from "vue";
import type { SourceId } from "@getsome/core";
import { ArrowUpRight, Check, Copy } from "lucide-vue-next";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { isRefundChain } from "@getsome/ephemeral";
import { shortAddress } from "../../utils/address";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { useRecoveryKey } from "../../composables/useRecoveryKey";
import { effectiveSourceId, type RequestFailure } from "../../funding/requests/model";
import type { FundingTopUp } from "../../funding/top-ups";
import { useRequestsStore } from "../../stores/requests";
import { useSessionStore } from "../../stores/session";
import { refundTxUrl } from "../../utils/explorer";
import { recoveryNotes, refundStatusTail } from "../../utils/recovery";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";
import RecoveryAddressCard from "../ui/RecoveryAddressCard.vue";
import RecoveryKeyCard from "../ui/RecoveryKeyCard.vue";

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

// The live world has the key outright; a refund opened from history has no world to read and
// re-derives it from the request's own identity. Both give address and secret together, which is
// what keeps the guide from pairing an address with a key that does not open it.
//
// Identity is `sourceId:tradeN` rather than the object: the list rebuilds its top-ups on every
// record tick, so while one is running the object's identity changes although which request this
// is has not — and re-deriving on each tick would drop the address the screen is showing.
const {
  address,
  secret,
  format,
  masked,
  material,
  resolving: recovering,
  toggle: toggleKey,
} = useRecoveryKey({
  identity: () => {
    const r = props.topUp?.request;
    return r ? `${r.sourceId}:${r.tradeN}` : null;
  },
  known: () => session.refundAddress,
  autoReveal: () => session.revealRefund,
  resolve: async () => {
    const live = session.revealRefundKey();
    if (live) return live;
    const request = props.topUp?.request;
    if (!request) return null;
    return await session.recoverRefundKeyFor(request.sourceId, request.tradeN);
  },
});

const notes = computed(() =>
  chain.value ? recoveryNotes(chain.value, asset.value, format.value) : null,
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

/** How far the refund has come, with its transaction split out so the screen can act on it. */
const status = computed(() => refundStatusTail(refund.value));
/** Where to watch it land. Null on a chain with no explorer mapped; the reference is still shown
 *  and still copyable, so the buyer can search for it themselves. */
const txUrl = computed(() => refundTxUrl(chain.value, status.value.txRef));

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

        <RecoveryAddressCard
          v-if="step.card === 'address' && address"
          :label="`Address on ${chain}`"
          :address="address"
        />

        <RecoveryKeyCard
          v-else-if="step.card === 'key' && material"
          :label="notes.secretLabel"
          :secret="secret"
          :masked="masked"
          @toggle="toggleKey"
        />
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
