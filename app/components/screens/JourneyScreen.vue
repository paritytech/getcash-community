<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed, onUnmounted, ref } from "vue";
import { Plus, X } from "lucide-vue-next";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { RefundKey } from "@getsome/ephemeral";
import { useFundingProgressClock } from "../../composables/useFundingProgressClock";
import type { FundingJourneyStatus } from "../../funding/handoff";
import { projectFundingProgress, type FundingProgressProjection } from "../../funding/progress";
import { useSessionStore } from "../../stores/session";
import { fmtCash } from "../../utils/cash";
import { recoveryNotes, refundedFailure } from "../../utils/recovery";
import FundingJourneyTimeline from "../funding/progress/FundingJourneyTimeline.vue";

const props = defineProps<{
  /**
   * A stored projection for a request not (yet) on screen; the live foreground wins when present.
   */
  progress?: FundingProgressProjection | null;
  /** The package's own word on its payment, shown above the timeline. */
  status?: FundingJourneyStatus | null;
}>();
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

/** The hero names the rail, and keeps naming it on failure. */
const railLabel = computed(() => {
  if (session.method === "card") return "Card";
  if (session.method === "bank") return "Bank";
  return "Crypto";
});
const heroLabel = computed(() =>
  finished.value ? `Added via ${railLabel.value}` : `Adding via ${railLabel.value}`,
);

const creditedAmount = computed(() =>
  session.claimedBase != null ? fmtCash(session.claimedBase) : session.amountHuman,
);
const amountText = computed(() =>
  finished.value ? `+${creditedAmount.value} CASH` : `${session.amountHuman} CASH`,
);

const hint = computed(() => {
  const s = state.value;
  if (!s) return null;
  if (session.fundingNotice) return session.fundingNotice;
  if (s.phase === "working") {
    if (s.mint.step === "awaiting-consent") {
      // "prompted" is the wait for the worker's verdict, "crediting" the moment it reported the
      // claim.
      return session.claimStage === "crediting"
        ? "Claimed. Adding the CASH to your balance…"
        : "Adding the CASH to your balance…";
    }
    return s.mint.step === "verifying" ? "Verifying the credit…" : null;
  }
  if (s.phase === "swapping") {
    switch (s.swap) {
      case "receiving":
        return null;
      case "swapping":
        return "Usually takes a few minutes…";
      case "sending":
        return "Sending DOT to Asset Hub, usually about 5 minutes…";
      default:
        return null;
    }
  }
  return null;
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

/** What the payment is denominated in, as a spelled-out currency where one exists
 *  ("EUR" → "Euro"); a crypto ticker stays a ticker. */
const payingIn = computed(() => {
  const symbol = session.quoted?.symbol;
  if (!symbol) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(symbol) ?? symbol;
  } catch {
    return symbol;
  }
});
// No Fees row yet: the quote carries no fee breakdown.
const detailRows = computed(() => {
  const q = session.quoted;
  if (!q) return [];
  return [
    { label: "Paying in", value: payingIn.value ?? q.symbol },
    { label: "Total", value: `${q.send} ${q.symbol}` },
  ];
});

/** The one ribbon line under the stepper: a failure reason beats a stage hint beats the
 *  package's own payment status. */
const message = computed(() => {
  if (failedText.value) return failedText.value;
  if (hint.value) return hint.value;
  if (props.status && props.status.tone !== "done") return props.status.text;
  return null;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
    <div class="flex flex-col items-center text-center">
      <span
        class="flex size-14 items-center justify-center rounded-full"
        :class="heroFailed ? 'journey-hero-failed' : 'bg-surface-container'"
      >
        <X v-if="heroFailed" class="size-6 text-fg-error" aria-hidden="true" />
        <Plus v-else class="size-6 text-fg-secondary" aria-hidden="true" />
      </span>
      <p class="mt-4 text-paragraph-l text-fg-secondary">{{ heroLabel }}</p>
      <p
        class="mt-2 text-display-m"
        :class="finished ? 'text-fg-success' : heroFailed ? 'text-fg-secondary' : 'text-fg-primary'"
      >
        {{ amountText }}
      </p>
      <p class="text-paragraph-l text-fg-secondary">To your balance</p>
    </div>

    <div class="mt-4 flex flex-1 flex-col gap-6">
      <!-- The stepper leaves once the CASH lands. -->
      <FundingJourneyTimeline
        v-if="progress && !finished"
        :progress="progress"
        :completed-steps="session.journeyDone"
        :message="message"
      />

      <dl v-if="detailRows.length" class="flex flex-col gap-4">
        <div
          v-for="row in detailRows"
          :key="row.label"
          class="flex items-baseline justify-between gap-4"
        >
          <dt class="text-paragraph-l text-fg-primary">{{ row.label }}</dt>
          <dd class="text-heading-m text-fg-primary">{{ row.value }}</dd>
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
