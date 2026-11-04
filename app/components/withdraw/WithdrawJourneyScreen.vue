<script setup lang="ts">
// The withdrawal's journey: from the payment out of the balance to the funds at the destination,
// on the shared timeline. Everything shown is read from the record; the actions go back to the
// route.
import { computed } from "vue";
import { RefreshCcw, X } from "lucide-vue-next";
import { formatBaseUnits, sellAmountOf } from "@getsome/meld";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import {
  saleVaultProxyNote,
  saleVaultProxyRelayable,
  useSaleVaultProxyStatus,
} from "../../composables/useSaleVaultProxyStatus";
import { SUCCESS_ICON_DELAY_MS, useJourneySuccess } from "../../composables/useJourneySuccess";
import {
  isWithdrawalSideExit,
  paymentTaken,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import { saleVaultProxyOfRecord } from "../../funding/requests/transitions/withdrawal";
import { TIMELINE_CADENCE_MS } from "../../funding/timeline/timelines";
import { useRequestsStore } from "../../stores/requests";
import { formatWhenInline, formatWhenShort } from "../../utils/journey";
import { fundsOnKey, saleTokenOnKey } from "../../withdraw/timeline/failure";
import { withdrawalJourneyRows } from "../../withdraw/timeline/journey-rows";
import { WITHDRAWAL_TIMELINE } from "../../withdraw/timeline/spec";
import FundingTimeline from "../funding/timeline/FundingTimeline.vue";
import TimelineBand from "../funding/timeline/TimelineBand.vue";
import CashAmount from "../ui/CashAmount.vue";
import CopiedPill from "../ui/CopiedPill.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import TransactionIcon from "../ui/TransactionIcon.vue";

const props = defineProps<{
  record: WithdrawalRecord;
  /** A line the record does not carry: a refused cancel, a retry that could not start. */
  notice: string | null;
  busy: boolean;
  /** The route still holds the quote behind the receive row, so the row can open its fees. */
  feesAvailable?: boolean;
  /** What the pool would land for a held withdrawal, formatted; null until quoted. */
  poolFigure?: string | null;
}>();
const emit = defineEmits<{
  cancel: [];
  retry: [];
  pool: [];
  close: [];
  "return-funds": [];
  claim: [];
  fees: [];
}>();
const requests = useRequestsStore();

const status = computed(() => props.record.status);
const sent = computed(() => status.value.kind === "sent");
const sideExit = computed(() => isWithdrawalSideExit(props.record));

const now = useFundingProgressClock(() =>
  sent.value || sideExit.value ? null : TIMELINE_CADENCE_MS,
);
/** The store's memo, so the journey never falls behind the line the list showed. */
const timeline = computed(() => requests.withdrawalTimelineOf(props.record, now.value));

/** The band's text: the route's notice, then the failure, then the timeline's own words. */
const timelineMessage = computed(
  () => props.notice ?? timeline.value.failure?.text ?? timeline.value.message?.text ?? null,
);
const timelineDetail = computed(() => timeline.value.detail ?? null);
const { success, successShown, successPlaying, drawn, band } = useJourneySuccess({
  succeeded: sent,
  view: () => timeline.value.view,
  message: timelineMessage,
  detail: timelineDetail,
});

const sentWhen = computed(() =>
  status.value.kind === "sent" && successShown.value ? formatWhenShort(status.value.at) : null,
);

const rows = computed(() =>
  withdrawalJourneyRows(props.record, { feesAvailable: props.feesAvailable === true }),
);
const copyable = computed(() => rows.value.some((row) => row.copy !== undefined));

/** What a sale left over once the provider was paid, and where it is. A sale that ended unpaid
 *  sends everything back, which its failure already says, so only the arrival is added. A way
 *  home that failed past the worker's retries says so, for support. */
const residueNote = computed(() => {
  const residue = props.record.residue;
  if (residue === undefined) return null;
  // A proxy's own note speaks for funds stuck on it, while the page can read one
  if (residue.stuck === true && (residue.onProxy !== true || proxyNote.value === null)) {
    return "What was left could not come back to your balance on its own.";
  }
  if (props.record.sale === undefined) return null;
  // In the token on the key at the sale's decimals, a remainder below them gets no line
  const token = saleTokenOnKey(props.record);
  const shown = residue.amount === undefined ? 0n : sellAmountOf(BigInt(residue.amount), token);
  const amount = shown === 0n ? null : `${formatBaseUnits(token, shown)} ${token.symbol}`;
  if (!residue.returning) {
    return amount === null
      ? null
      : `The ${amount} left over was too little to send back, and stays with this withdrawal.`;
  }
  if (residue.whole === true || amount === null) {
    return residue.returned ? "Your funds came back to your balance as CASH." : null;
  }
  return residue.returned
    ? `The ${amount} left over came back to your balance as CASH.`
    : `The ${amount} left over is on its way back to your balance.`;
});

/** The way on from an ending: the refund guide, a retry, or nothing more than closing. */
const action = computed(() => timeline.value.failure?.action ?? null);
/** The design's word on a sale that ended for good: the seller starts another from the quote. */
const closeLabel = computed(() =>
  action.value === "close" && props.record.route !== "crypto" ? "Start over" : "Close",
);
/** Funds left on the withdrawal's own key, failed or sent, open the guide that hands over its key. */
const returnFunds = computed(() => fundsOnKey(props.record));
/** The pool is offered only where waiting cannot help: the PSM refused with room for the redeem. */
const canSwitchToPool = computed(
  () => action.value === "try-again" && props.record.failure?.kind === "held",
);
/** Cancel is offered only while nothing was paid and the host has nothing in hand. */
const canCancel = computed(
  () => status.value.kind === "awaiting-payment" && !paymentTaken(props.record),
);
// Only a proxy sale whose swap reached its egress can have an on-chain state worth reading
const saleProxy = computed(() => saleVaultProxyOfRecord(props.record));
const proxySale = () => {
  const { rail } = props.record;
  if (saleProxy.value === undefined) return undefined;
  if (rail.stage !== "delivered" && rail.stageAt?.sending === undefined) return undefined;
  return { fundingRequestId: saleProxy.value.fundingRequestId, chainId: saleProxy.value.chainId };
};
const { status: proxy, error: proxyError } = useSaleVaultProxyStatus(proxySale);

/** What the proxy says about the seller's funds, or null when it has nothing to add. */
const proxyNote = computed(() => {
  const kept = saleProxy.value;
  if (proxy.value === null || kept === undefined) return null;
  return saleVaultProxyNote(
    proxy.value,
    (units) => formatBaseUnits(kept.token, units),
    (ms) => formatWhenInline(ms),
    props.record.residue?.stuck === true,
  );
});
/** When a return that was refused or killed is tried again. */
const proxyRetryAt = computed(() => {
  const p = proxy.value;
  return p?.blockedReason === "not-due" && p.nextReturnAt !== null
    ? `Sending back again ${formatWhenInline(p.nextReturnAt)}.`
    : null;
});
/** Funds on the seller's own Arbitrum address open the screen that moves them, as it reads them. */
const canClaim = computed(
  () =>
    proxy.value !== null &&
    saleProxy.value?.claimerAddress !== undefined &&
    saleVaultProxyRelayable(proxy.value) > 0n,
);
</script>

<template>
  <!-- The scroller carries -mx-4/px-4 so the timeline card's bleed isn't clipped: overflow-y-auto
       also clips x, and the clip runs at the padding box. -->
  <div class="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-cta">
    <div class="flex flex-col items-center text-center">
      <span
        class="journey-stack size-14 rounded-full"
        :class="sideExit ? 'journey-hero-failed' : 'bg-surface-container'"
      >
        <X v-if="sideExit" class="size-6 text-fg-error" aria-hidden="true" />
        <template v-else>
          <RefreshCcw
            v-if="!successShown || successPlaying"
            class="size-6 text-fg-primary"
            :class="{ 'journey-icon-out': successPlaying }"
            aria-hidden="true"
          />
          <TransactionIcon
            v-if="successShown"
            class="size-14"
            :animate="successPlaying"
            :delay="SUCCESS_ICON_DELAY_MS"
          />
        </template>
      </span>
      <p class="journey-stack mt-2 text-display-m">
        <CashAmount
          v-if="!successShown || successPlaying"
          :amount="record.amountHuman"
          sign=""
          :class="[
            sideExit ? 'text-fg-secondary' : 'text-fg-primary',
            { 'journey-amount-out': successPlaying },
          ]"
        />
        <CashAmount
          v-if="successShown"
          :amount="record.amountHuman"
          sign="-"
          class="text-fg-primary"
          :class="{ 'journey-amount-in': successPlaying }"
        />
      </p>
      <div v-if="sentWhen" :class="{ 'journey-date-in': successPlaying }">
        <p class="text-paragraph-l text-fg-secondary">{{ sentWhen }}</p>
      </div>
    </div>

    <div class="mt-6 flex flex-1 flex-col gap-6">
      <!-- The timeline leaves once the funds are sent. -->
      <div v-if="success !== 'shown'" :class="{ 'journey-timeline-out': successPlaying }">
        <FundingTimeline
          v-if="timeline.view"
          :spec="WITHDRAWAL_TIMELINE"
          :view="timeline.view"
          :message="band.message"
          :detail="band.detail"
          @completed="drawn"
        />
        <TimelineBand
          v-else
          :label="WITHDRAWAL_TIMELINE.ariaLabel"
          :message="band.message"
          :detail="band.detail"
        />
      </div>

      <DetailRows v-if="rows.length" :rows="rows" @fees="emit('fees')" />
      <!-- The reference copies, so the screen carries the confirmation. -->
      <CopiedPill v-if="copyable" />
      <p v-if="residueNote" class="text-body-s text-fg-secondary">{{ residueNote }}</p>
      <!-- The sale's proxy: a provider that was not paid or refunded, and the way home. -->
      <div v-if="proxyNote || proxyRetryAt || proxyError || canClaim" class="flex flex-col gap-2">
        <p v-if="proxyNote" class="text-body-s text-fg-secondary">{{ proxyNote }}</p>
        <p v-if="proxyRetryAt" class="text-body-s text-fg-secondary">{{ proxyRetryAt }}</p>
        <p v-if="proxyError" class="text-body-s text-fg-error">{{ proxyError }}</p>
        <p v-if="canClaim" class="text-body-s text-fg-secondary">
          Your USDC is on your own Arbitrum address. This moves it to an address you choose, with no
          ETH needed.
        </p>
        <PillButton v-if="canClaim" variant="tertiary" @click="emit('claim')">
          Move my USDC
        </PillButton>
      </div>

      <PillButton v-if="returnFunds" class="mt-auto" @click="emit('return-funds')">
        {{ record.route === "crypto" ? "Return funds" : "Recover funds" }}
      </PillButton>
      <div v-else-if="action === 'try-again'" class="mt-auto flex flex-col gap-3">
        <PillButton :disabled="busy" @click="emit('retry')">Try again</PillButton>
        <PillButton
          v-if="canSwitchToPool"
          variant="tertiary"
          :disabled="busy || !poolFigure"
          @click="emit('pool')"
        >
          Sell on the pool{{ poolFigure ? ` for about ${poolFigure}` : "" }}
        </PillButton>
      </div>
      <!-- Cancel and retry never show together: cancel is for an unpaid request, retry for a
           failed one. -->
      <PillButton
        v-if="canCancel"
        variant="tertiary"
        class="mt-auto"
        :disabled="busy"
        @click="emit('cancel')"
      >
        Cancel withdrawal
      </PillButton>
      <PillButton
        v-if="successShown || action === 'close'"
        variant="tertiary"
        class="mt-auto"
        :class="{ 'journey-close-in': successPlaying }"
        @click="emit('close')"
      >
        {{ closeLabel }}
      </PillButton>
    </div>
  </div>
</template>
