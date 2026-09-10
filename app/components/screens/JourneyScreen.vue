<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed, onUnmounted, ref } from "vue";
import { ChevronRight, Plus, RefreshCcw, X } from "lucide-vue-next";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { RefundKey } from "@getsome/ephemeral";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import type { FundingJourneyStatus } from "../../funding/handoff";
import { projectFundingProgress, type FundingProgressProjection } from "../../funding/progress";
import type { FundingTopUp } from "../../funding/top-ups";
import { useSessionStore } from "../../stores/session";
import { fmtCash } from "../../utils/cash";
import { fmtFiat } from "../../utils/money";
import { formatWhenShort } from "../../utils/journey";
import { recoveryNotes, refundedFailure } from "../../utils/recovery";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";

const props = defineProps<{
  /**
   * A stored projection for a request not (yet) on screen; the live foreground wins when present.
   */
  progress?: FundingProgressProjection | null;
  /** The package's own word on its payment, shown above the timeline. */
  status?: FundingJourneyStatus | null;
  /** The top-up as the list knows it; its stored quote backs the detail rows until the request
   *  is live in the store. */
  topUp?: FundingTopUp | null;
}>();
// fees asks the host to swap in the fee-breakdown drill-in; close leaves the finished journey.
const emit = defineEmits<{ fees: []; close: [] }>();
const session = useSessionStore();

const cadence = computed(
  () => session.foregroundProgress?.snapshot.profile.cadenceMs ?? props.progress?.cadenceMs ?? null,
);
const now = useFundingProgressClock(cadence);
const progress = computed(() => {
  const foreground = session.foregroundProgress;
  if (foreground) {
    return projectFundingProgress({
      snapshot: foreground.snapshot,
      createdAt: foreground.startedAt,
      now: now.value,
    });
  }
  return props.progress ?? null;
});

const state = computed(() => session.lastState);
const finished = computed(() => session.phase === "done");
const failure = computed(() => (state.value?.phase === "failed" ? state.value.failure : null));
const failedText = computed(() => session.fundingError ?? failure.value?.message ?? null);

const heroFailed = computed(() => progress.value?.view.kind === "failed" || failure.value !== null);

const creditedAmount = computed(() =>
  session.claimedBase != null ? fmtCash(session.claimedBase) : session.amountHuman,
);
const amountText = computed(() => {
  if (finished.value) return `+${creditedAmount.value} $CASH`;
  // The store's amount is empty until the request is live; the list's word on it fills in.
  return `${session.amountHuman || (props.topUp?.amount ?? "")} $CASH`;
});

/** When the CASH landed: the live milestone, else the list's settled timestamp. */
const settledWhen = computed(() => {
  if (!finished.value) return null;
  const at =
    session.milestones[5] ?? (props.topUp?.state.kind === "settled" ? props.topUp.state.at : null);
  return at != null ? formatWhenShort(at) : null;
});

/** Whether the failed swap's deposit is being refunded to this request's own key. */
const refunded = computed(
  () =>
    failure.value !== null && refundedFailure(failure.value.kind) && session.refundAddress !== null,
);
const refund = computed(() => (state.value?.phase === "failed" ? state.value.refund : undefined));
const asset = computed(() => {
  const sourceId = state.value?.sourceId;
  return sourceId ? (SOURCE_CONFIG_BY_ID.get(sourceId)?.asset ?? "") : "";
});
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a);
const refundStatus = computed(() => {
  if (failure.value?.kind === "refund-failed") return failure.value.message;
  if (refund.value?.witnessedAt) return `Your ${asset.value} is back at the address below.`;
  if (refund.value?.txRef) {
    return `Your ${asset.value} is on its way back, transaction ${short(refund.value.txRef)}.`;
  }
  return `Your ${asset.value} is being returned to the address below.`;
});

/** The key is read on tap, never on load, and stays masked until tapped again. */
const revealed = ref<RefundKey | null>(null);
const notes = computed(() => (revealed.value ? recoveryNotes(revealed.value, asset.value) : null));
function reveal() {
  revealed.value = session.revealRefundKey();
}
const secretShown = ref(false);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copySecret() {
  if (!revealed.value) return;
  try {
    await navigator.clipboard.writeText(revealed.value.secret);
    copied.value = true;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    console.warn("[recovery] clipboard write failed:", e);
  }
}
onUnmounted(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});

/** The rows' source: the live quote, else the top-up's stored one. Only the live quote carries
 *  the split the fee drill-in needs. */
const quoteView = computed(() => {
  const q = session.quoted;
  if (q) {
    return {
      amount: q.send,
      symbol: q.symbol,
      fee: q.fee ?? null,
      crypto: session.method === "crypto",
      live: true,
    };
  }
  const stored = props.topUp?.quote;
  if (!stored) return null;
  return {
    amount: stored.amount,
    symbol: stored.symbol,
    fee: stored.fee ?? null,
    crypto: props.topUp?.route === "crypto",
    live: false,
  };
});
const detailRows = computed(() => {
  const q = quoteView.value;
  if (!q) return [];
  // Symbol-first for the fiat rails ("€50.55"); crypto keeps its full-precision ticker form.
  const money = (amount: string) =>
    q.crypto ? `${amount} ${q.symbol}` : fmtFiat(amount, q.symbol);
  const rows: { label: string; value: string; fees?: boolean }[] = [];
  // The fee row drills into the breakdown screen when the live quote backs it.
  if (q.fee) rows.push({ label: "Fees", value: money(q.fee), fees: q.live });
  rows.push({ label: "Total", value: money(q.amount) });
  return rows;
});

/** Temporarily stuck (the provider is retrying): amber on the stepper, never terminal. */
const delayed = computed(() => session.meldDelayed && !finished.value && !heroFailed.value);

/** The one ribbon line under the stepper. The design keeps the happy path silent: only a failure
 *  reason, an out-of-band notice, or a transient delay earns the ribbon. */
const message = computed(() => {
  if (failedText.value) return failedText.value;
  if (session.fundingNotice) return session.fundingNotice;
  if (delayed.value) return "Taking a little longer than usual";
  if (props.status && props.status.tone === "failed") return props.status.text;
  return null;
});
</script>

<template>
  <!-- The scroller carries -mx-4/px-4 so the timeline card's bleed isn't clipped: overflow-y-auto
       also clips x, and the clip runs at the padding box. -->
  <div class="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
    <div class="flex flex-col items-center text-center">
      <span
        class="flex size-14 items-center justify-center rounded-full"
        :class="heroFailed ? 'journey-hero-failed' : 'bg-surface-container'"
      >
        <X v-if="heroFailed" class="size-6 text-fg-error" aria-hidden="true" />
        <Plus v-else-if="finished" class="size-6 text-fg-primary" aria-hidden="true" />
        <RefreshCcw v-else class="size-6 text-fg-primary" aria-hidden="true" />
      </span>
      <p
        class="mt-2 text-display-m"
        :class="finished ? 'text-fg-success' : heroFailed ? 'text-fg-secondary' : 'text-fg-primary'"
      >
        {{ amountText }}
      </p>
      <p v-if="settledWhen" class="text-paragraph-l text-fg-secondary">{{ settledWhen }}</p>
    </div>

    <div class="mt-4 flex flex-1 flex-col gap-6">
      <!-- The stepper leaves once the CASH lands. -->
      <FundingJourneyTimeline
        v-if="progress && !finished"
        :progress="progress"
        :completed-steps="session.journeyDone"
        :message="message"
        :delayed="delayed"
      />

      <dl v-if="detailRows.length" class="flex flex-col gap-4">
        <div
          v-for="row in detailRows"
          :key="row.label"
          class="flex items-baseline justify-between gap-4"
        >
          <dt class="text-paragraph-l text-fg-primary">{{ row.label }}</dt>
          <dd v-if="row.fees">
            <button
              type="button"
              class="flex items-center gap-1 text-heading-m text-fg-primary"
              @click="emit('fees')"
            >
              {{ row.value }}
              <ChevronRight class="size-4 text-fg-secondary" aria-hidden="true" />
            </button>
          </dd>
          <dd v-else class="text-heading-m text-fg-primary">{{ row.value }}</dd>
        </div>
      </dl>

      <!-- The way back to a refunded deposit: the key controlling the address it returns to. -->
      <template v-if="refunded">
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
          <button
            type="button"
            class="self-start rounded-medium bg-action-secondary px-4 py-2.5 text-label-m text-fg-primary transition-colors hover:bg-action-secondary-hover"
            @click="copySecret"
          >
            {{ copied ? "Copied" : "Copy key" }}
          </button>
          <p v-if="notes.gasNote" class="text-body-m text-fg-secondary">
            {{ notes.gasNote }}
          </p>
          <p class="text-body-m text-fg-error">
            Anyone with this key controls the funds. Import it into a wallet and move them.
          </p>
        </div>
        <button
          v-else
          type="button"
          class="h-12 rounded-full bg-action-primary text-label-l font-semibold text-fg-primary-inverted transition-colors hover:bg-action-primary-hover"
          @click="reveal"
        >
          Get your funds back
        </button>
      </template>

      <button
        v-if="failure?.recoverable"
        type="button"
        class="mt-auto h-12 shrink-0 rounded-full bg-action-primary text-label-l font-semibold text-fg-primary-inverted transition-colors hover:bg-action-primary-hover"
        @click="session.retry()"
      >
        Try again
      </button>

      <button
        v-if="finished"
        type="button"
        class="mt-auto h-12 shrink-0 rounded-full bg-action-tertiary text-label-l font-semibold text-fg-primary transition-colors hover:bg-action-tertiary-hover"
        @click="emit('close')"
      >
        Close
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The failed hero circle binds the red-alpha primitive in the design; no semantic
 * token covers it (reported gap). */
.journey-hero-failed {
  background: var(--palette-red-alpha-24);
}
</style>
