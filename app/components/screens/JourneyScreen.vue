<script setup lang="ts">
// The finish of a top-up: the timeline from a confirmed deposit to CASH in the balance, shared by
// every package.
import { computed, onUnmounted, ref } from "vue";
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

const heroLabel = computed(() => {
  if (finished.value) return "Added";
  if (progress.value?.view.kind === "failed") return "Top-up";
  return "Adding";
});

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

const message = computed(() => failedText.value ?? hint.value);
const messageTone = computed<"muted" | "notice" | "error">(() => {
  if (failedText.value) return "error";
  if (session.fundingNotice) return "notice";
  return "muted";
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
    <div class="flex flex-col items-center text-center">
      <span class="flex size-14 items-center justify-center rounded-full bg-surface-container">
        <img src="/icons/plus.svg" alt="" class="size-6" />
      </span>
      <p class="mt-4 text-base leading-5 text-text-secondary">{{ heroLabel }}</p>
      <p
        class="mt-3 text-[56px] leading-[64px] font-semibold"
        :class="finished ? 'text-[#5dcaa5]' : 'text-text-primary'"
      >
        {{ amountText }}
      </p>
      <p class="text-base leading-5 text-text-secondary">To your balance</p>
      <!-- The package's payment status, e.g. a card confirming or a bank transfer settled. -->
      <span
        v-if="status"
        class="mt-3 inline-flex items-center gap-2 rounded-full bg-surface-container px-3 py-1.5 text-xs font-medium"
        :class="
          status.tone === 'failed'
            ? 'text-error'
            : status.tone === 'done'
              ? 'text-[#5dcaa5]'
              : 'text-text-secondary'
        "
      >
        <img v-if="status.tone === 'done'" src="/icons/check.svg" alt="" class="size-3.5" />
        <img v-else-if="status.tone === 'failed'" src="/icons/x.svg" alt="" class="size-3.5" />
        <span
          v-else
          class="size-3 animate-spin rounded-full border-2 border-track border-t-white"
          aria-hidden="true"
        />
        {{ status.text }}
      </span>
    </div>

    <div class="mt-10 flex flex-col gap-6">
      <FundingJourneyTimeline
        v-if="progress"
        :progress="progress"
        :message="message"
        :message-tone="messageTone"
      />

      <!-- The way back to a refunded deposit: the key controlling the address it returns to. -->
      <template v-if="refunded">
        <p class="text-sm leading-5 text-text-secondary">{{ refundStatus }}</p>
        <div v-if="revealed && notes" class="flex flex-col gap-4">
          <dl class="flex flex-col gap-3">
            <div>
              <dt class="text-sm text-text-secondary">Address on {{ revealed.chain }}</dt>
              <dd class="font-mono text-sm break-all">{{ revealed.address }}</dd>
            </div>
            <div>
              <dt class="text-sm text-text-secondary">{{ notes.secretLabel }}</dt>
              <dd>
                <button
                  type="button"
                  class="w-full text-left font-mono text-sm break-all"
                  :aria-pressed="secretShown"
                  @click="secretShown = !secretShown"
                >
                  <template v-if="secretShown">{{ revealed.secret }}</template>
                  <template v-else>
                    <span aria-hidden="true">••••••••••••••••••••••••</span>
                    <span class="ml-2 font-sans text-text-secondary">Tap to show</span>
                  </template>
                </button>
              </dd>
            </div>
          </dl>
          <button
            type="button"
            class="self-start rounded-full bg-chip px-4 py-2.5 text-sm font-semibold"
            @click="copySecret"
          >
            {{ copied ? "Copied" : "Copy key" }}
          </button>
          <p v-if="notes.gasNote" class="text-sm leading-5 text-text-secondary">
            {{ notes.gasNote }}
          </p>
          <p class="text-sm leading-5 text-error">
            Anyone with this key controls the funds. Import it into a wallet and move them.
          </p>
        </div>
        <button
          v-else
          type="button"
          class="h-12 rounded-full bg-action-primary text-base leading-6 font-semibold text-text-inverted"
          @click="reveal"
        >
          Get your funds back
        </button>
      </template>

      <button
        v-if="failure?.recoverable"
        type="button"
        class="h-12 rounded-full bg-action-primary text-base leading-6 font-semibold text-text-inverted"
        @click="session.retry()"
      >
        Try again
      </button>
    </div>
  </div>
</template>
