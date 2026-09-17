<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Check,
  Copy,
  Delete,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
} from "lucide-vue-next";
import {
  getHostLocalStorage,
  getPaymentManager,
  type HostLocalStorage,
  type HostPaymentBalanceSubscribeItem,
  type HostSubscription,
} from "@parity/product-sdk-host";
import Toolbar from "~~/app/components/ui/Toolbar.vue";
import { useCopyToClipboard } from "~~/app/composables/useCopyToClipboard";
import { useVisualViewportHeight } from "~~/app/composables/useVisualViewportHeight";
import { withTimeout } from "~~/lib/timeout";
import { getStorageWorkerManager } from "~~/lib/worker-rpc";
import { WITHDRAW_RPC, type WithdrawJobView, type WithdrawStatusView } from "../worker/rpc";
import {
  canResumeSnapshot,
  createWithdrawController,
  type WithdrawControllerSnapshot,
} from "./controller";
import {
  clearPendingWithdrawHandoff,
  createWithdrawId,
  displayHandoffAmount,
  formatWithdrawAmount,
  isKnownWithdrawStatus,
  isTerminalWithdraw,
  readPendingWithdrawHandoff,
  reduceWithdrawAmount,
  withdrawAmountState,
  withdrawPresentation,
  writePendingWithdrawHandoff,
  type PendingWithdrawHandoff,
  type WithdrawAmountKey,
} from "./model";
import { revealWithdrawSeed, type RevealedWithdrawSeed } from "./secret";

useVisualViewportHeight();

const worker = getStorageWorkerManager();
const amount = ref("");
const available = ref<bigint | null>(null);
const balanceError = ref<string | null>(null);
const hostStore = ref<HostLocalStorage | null>(null);
const formError = ref<string | null>(null);
const revealedSeed = ref<RevealedWithdrawSeed | null>(null);
const revealError = ref<string | null>(null);
const revealing = ref(false);
const revealGeneration = ref(0);
const copiedValue = ref<string | null>(null);
const amountRow = ref<HTMLElement | null>(null);
const amountValue = ref<HTMLElement | null>(null);
const amountAsset = ref<HTMLElement | null>(null);

const keypad: readonly (readonly WithdrawAmountKey[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  [".", "0", "delete"],
];

const { copied, copy } = useCopyToClipboard();
let balanceSubscription: HostSubscription | null = null;
let cancelBalanceInterrupt: (() => void) | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let resizeObserver: ResizeObserver | null = null;
let unsubscribeController: (() => void) | null = null;
let firstBalanceTimer: ReturnType<typeof setTimeout> | null = null;
let mounted = false;

const controller = createWithdrawController({
  readPending: async () => readPendingWithdrawHandoff(await loadHostStore()),
  writePending: async (handoff) => writePendingWithdrawHandoff(await loadHostStore(), handoff),
  clearPending: async () => clearPendingWithdrawHandoff(await loadHostStore()),
  start: (handoff) =>
    worker.call<WithdrawStatusView>(
      WITHDRAW_RPC.start,
      { id: handoff.id, amount: handoff.amount },
      { deadlineMs: 20_000 },
    ),
  status: (id) =>
    worker.call<WithdrawStatusView>(WITHDRAW_RPC.status, id ? { id } : undefined, {
      deadlineMs: 10_000,
    }),
  resume: () =>
    worker.call<void>(WITHDRAW_RPC.tickAll, { includeUnknown: true }, { deadlineMs: 30_000 }),
  createId: () => createWithdrawId((bytes) => globalThis.crypto.getRandomValues(bytes)),
  now: () => Date.now(),
  messageOf,
});
const controllerSnapshot = ref<WithdrawControllerSnapshot>(controller.snapshot());
const pending = computed(() => controllerSnapshot.value.pending);
const pendingBlockedReason = computed(() => controllerSnapshot.value.pendingBlockedReason);
const status = computed(() => controllerSnapshot.value.status);
const workerError = computed(() => controllerSnapshot.value.workerError);
const starting = computed(() => controllerSnapshot.value.starting);
const resuming = computed(() => controllerSnapshot.value.resuming);

const activeJob = computed(() => (isKnownWithdrawStatus(status.value) ? status.value : null));
const terminalJob = computed(() => {
  const job = activeJob.value;
  return job && isTerminalWithdraw(job) ? job : null;
});
const blocksNewWithdrawal = computed(
  () =>
    pendingBlockedReason.value !== null ||
    pending.value !== null ||
    (!!activeJob.value && !isTerminalWithdraw(activeJob.value)),
);
const amountState = computed(() => withdrawAmountState(amount.value, available.value));
const presentation = computed(() =>
  withdrawPresentation(status.value, pending.value, workerError.value),
);
const displayAmount = computed(() =>
  formatEditableAmount(amount.value === "" ? "0" : amount.value),
);
const availableLabel = computed(() =>
  available.value === null
    ? balanceError.value
      ? "Balance unavailable"
      : "Loading balance"
    : `${formatWithdrawAmount(available.value, { minDecimals: 2 })} CASH`,
);
const amountMessage = computed(() => {
  if (pendingBlockedReason.value) return pendingBlockedReason.value;
  if (balanceError.value) return balanceError.value;
  if (formError.value) return formError.value;
  const state = amountState.value;
  if (state.kind === "valid" || state.kind === "empty") return `Available ${availableLabel.value}`;
  return state.message;
});
const canWithdraw = computed(
  () =>
    controllerSnapshot.value.initialized &&
    amountState.value.kind === "valid" &&
    !starting.value &&
    !blocksNewWithdrawal.value,
);
const canResume = computed(() => !starting.value && canResumeSnapshot(controllerSnapshot.value));
const handoffAmount = computed(() => displayHandoffAmount(pending.value, status.value));
const statusAmount = computed(() => {
  const job = terminalJob.value;
  if (job?.phase === "done" && job.assetHubCredit) {
    return `${formatSignedAmount(job.assetHubCredit.delta)} pUSD received`;
  }
  return handoffAmount.value ? `${handoffAmount.value} CASH` : null;
});
const statusId = computed(() => (activeJob.value ? activeJob.value.id : pending.value?.id));
const details = computed(() => detailRows(activeJob.value, pending.value));

watch(displayAmount, fitAmount, { flush: "post" });
watch(
  () => activeJob.value?.id ?? null,
  () => hideSeed(),
);
watch(copied, (isCopied) => {
  if (!isCopied) copiedValue.value = null;
});

onMounted(() => {
  mounted = true;
  unsubscribeController = controller.subscribe((snapshot) => {
    if (mounted) controllerSnapshot.value = snapshot;
  });
  fitAmount();
  if (typeof ResizeObserver !== "undefined" && amountRow.value) {
    resizeObserver = new ResizeObserver(fitAmount);
    resizeObserver.observe(amountRow.value);
  }
  document.fonts?.ready.then(fitAmount);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void controller.initialize();
  void subscribeBalance();
  statusTimer = setInterval(() => void controller.refresh({ quiet: true }), 4_000);
});

onBeforeUnmount(() => {
  mounted = false;
  controller.dispose();
  unsubscribeController?.();
  hideSeed();
  cleanupBalanceSubscription();
  if (statusTimer !== null) clearInterval(statusTimer);
  resizeObserver?.disconnect();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
});

function enter(key: WithdrawAmountKey): void {
  formError.value = null;
  amount.value = reduceWithdrawAmount(amount.value, key);
}

async function startWithdrawal(): Promise<void> {
  formError.value = null;
  const state = amountState.value;
  if (state.kind !== "valid") {
    formError.value = state.kind === "empty" ? "Enter a CASH amount." : state.message;
    return;
  }
  hideSeed();
  const result = await controller.start(state.baseUnits.toString());
  if (result.kind === "blocked") formError.value = result.reason ?? "Withdrawal is not ready.";
}

async function resumeWithdrawal(): Promise<void> {
  hideSeed();
  await controller.resume();
}

async function retryInitialization(): Promise<void> {
  hideSeed();
  void subscribeBalance();
  await controller.initialize();
}

async function revealSeed(): Promise<void> {
  const job = activeJob.value;
  if (!job) return;
  const generation = revealGeneration.value + 1;
  revealGeneration.value = generation;
  revealError.value = null;
  revealing.value = true;
  try {
    const seed = await withTimeout(revealWithdrawSeed(job), 10_000, "Recovery key");
    if (mounted && revealGeneration.value === generation && document.visibilityState !== "hidden") {
      revealedSeed.value = seed;
    }
  } catch (error) {
    if (mounted && revealGeneration.value === generation) {
      revealedSeed.value = null;
      revealError.value = messageOf(error);
    }
  } finally {
    if (mounted && revealGeneration.value === generation) revealing.value = false;
  }
}

function hideSeed(): void {
  if (revealedSeed.value && copiedValue.value === revealedSeed.value.seedHex)
    copiedValue.value = null;
  revealGeneration.value += 1;
  revealedSeed.value = null;
  revealError.value = null;
  revealing.value = false;
}

async function copyDetail(value: string): Promise<void> {
  copiedValue.value = value;
  await copy(value);
}

async function subscribeBalance(): Promise<void> {
  cleanupBalanceSubscription();
  try {
    firstBalanceTimer = setTimeout(() => {
      if (mounted && available.value === null) {
        balanceError.value = "Private CASH balance is still unavailable.";
      }
    }, 10_000);
    const manager = await withTimeout(getPaymentManager(), 10_000, "Host payments");
    if (!mounted) return;
    if (!manager) {
      balanceError.value = "Private CASH balance is unavailable outside the host.";
      return;
    }
    balanceSubscription = manager.subscribeBalance((balance: HostPaymentBalanceSubscribeItem) => {
      if (!mounted) return;
      if (firstBalanceTimer !== null) {
        clearTimeout(firstBalanceTimer);
        firstBalanceTimer = null;
      }
      available.value = balance.available;
      balanceError.value = null;
    });
    cancelBalanceInterrupt = balanceSubscription.onInterrupt((reason) => {
      if (!mounted) return;
      balanceError.value = `Private CASH balance stopped updating: ${String(reason ?? "interrupted")}`;
      available.value = null;
    });
  } catch (error) {
    balanceError.value = messageOf(error);
  }
}

function cleanupBalanceSubscription(): void {
  balanceSubscription?.unsubscribe();
  balanceSubscription = null;
  cancelBalanceInterrupt?.();
  cancelBalanceInterrupt = null;
  if (firstBalanceTimer !== null) {
    clearTimeout(firstBalanceTimer);
    firstBalanceTimer = null;
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    hideSeed();
  } else {
    void controller.refresh({ quiet: true });
  }
}

async function loadHostStore(): Promise<HostLocalStorage | null> {
  if (hostStore.value) return hostStore.value;
  hostStore.value = await withTimeout(getHostLocalStorage(), 10_000, "Host storage");
  return hostStore.value;
}

function fitAmount(): void {
  const row = amountRow.value;
  const value = amountValue.value;
  const asset = amountAsset.value;
  if (!row || !value || !asset) return;

  row.style.setProperty("--amount-scale", "1");
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  const natural = value.getBoundingClientRect().width + asset.getBoundingClientRect().width;
  const availableWidth = row.clientWidth - gap;
  const scale = natural > 0 && availableWidth > 0 ? Math.min(1, availableWidth / natural) : 1;
  row.style.setProperty("--amount-scale", scale.toFixed(4));
}

function formatEditableAmount(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function messageOf(error: unknown): string {
  const tag = error && typeof error === "object" ? (error as { tag?: unknown }).tag : undefined;
  if (tag === "timeout") return "Background processing is still starting.";
  if (tag === "unavailable") return "Background processing is unavailable right now.";
  if (tag === "denied") return "The host denied the request.";
  if (tag === "invalid") return error instanceof Error ? error.message : "The request was refused.";
  return error instanceof Error ? error.message : String(error);
}

interface DetailRow {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}

function detailRows(
  job: WithdrawJobView | null,
  saved: PendingWithdrawHandoff | null,
): readonly DetailRow[] {
  const rows: DetailRow[] = [];
  if (saved && !job) {
    rows.push(
      { key: "payment-id", label: "Payment ID", value: saved.id, mono: true, copy: true },
      {
        key: "requested",
        label: "Requested",
        value: `${formatWithdrawAmount(BigInt(saved.amount), { minDecimals: 2 })} CASH`,
      },
    );
    return rows;
  }
  if (!job) return rows;

  rows.push(
    { key: "payment-id", label: "Payment ID", value: job.id, mono: true, copy: true },
    {
      key: "requested",
      label: "Requested",
      value: `${formatWithdrawAmount(BigInt(job.amount), { minDecimals: 2 })} CASH`,
    },
  );
  if (job.payment?.actualClaimed) {
    rows.push({
      key: "claimed",
      label: job.payment.status === "partiallyClaimed" ? "Actually claimed" : "Payment claimed",
      value: `${formatWithdrawAmount(BigInt(job.payment.actualClaimed), { minDecimals: 2 })} CASH`,
    });
  }
  if (job.account) {
    rows.push(
      {
        key: "address",
        label: "Disposable address",
        value: job.account.peopleAddress,
        mono: true,
        copy: true,
      },
      {
        key: "public-key",
        label: "Public key",
        value: job.account.publicKeyHex,
        mono: true,
        copy: true,
      },
    );
  }
  if (job.prepared?.pUsdTransfer) {
    rows.push({
      key: "expected-pusd",
      label: "Expected net",
      value: `${formatWithdrawAmount(BigInt(job.prepared.pUsdTransfer), { minDecimals: 2 })} pUSD`,
    });
  }
  if (job.prepared?.maxPUsdSwapInput) {
    rows.push({
      key: "swap-budget",
      label: "Max fee swap",
      value: `${formatWithdrawAmount(BigInt(job.prepared.maxPUsdSwapInput), {
        minDecimals: 2,
      })} pUSD`,
    });
  }
  if (job.assetHubCredit) {
    rows.push({
      key: "received-pusd",
      label: job.phase === "done" ? "Final Asset Hub pUSD" : "Asset Hub pUSD seen",
      value: `${formatSignedAmount(job.assetHubCredit.delta)} pUSD`,
    });
  }
  if (job.submission?.txHash) {
    rows.push({
      key: "tx-hash",
      label: "Batch tx",
      value: job.submission.txHash,
      mono: true,
      copy: true,
    });
  }
  if (job.failure || job.lastError) {
    rows.push({ key: "failure", label: "Message", value: job.failure ?? job.lastError! });
  }
  return rows;
}

function formatSignedAmount(value: string): string {
  const amountValue = BigInt(value);
  if (amountValue < 0n) return `-${formatWithdrawAmount(-amountValue, { minDecimals: 2 })}`;
  return formatWithdrawAmount(amountValue, { minDecimals: 2 });
}
</script>

<template>
  <main class="withdraw-screen" aria-labelledby="withdraw-title">
    <Toolbar title="Withdraw CASH" />
    <h1 id="withdraw-title" class="sr-only">Withdraw CASH</h1>

    <section class="withdraw-scroll">
      <section
        v-if="statusId || terminalJob || pendingBlockedReason"
        class="withdraw-status"
        :class="{ 'withdraw-status-unavailable': pendingBlockedReason }"
        aria-live="polite"
      >
        <div class="withdraw-status-heading">
          <span class="withdraw-status-icon" :class="`withdraw-status-icon-${presentation.tone}`">
            <Check v-if="presentation.tone === 'success'" class="size-5" aria-hidden="true" />
            <RefreshCw
              v-else-if="presentation.tone === 'unknown'"
              class="size-5"
              aria-hidden="true"
            />
            <LoaderCircle v-else class="size-5" aria-hidden="true" />
          </span>
          <div>
            <p class="text-heading-l text-fg-primary">
              {{ pendingBlockedReason ? "Withdrawal state unavailable" : presentation.title }}
            </p>
            <p v-if="statusAmount" class="text-body-m text-fg-secondary">
              {{ statusAmount }}
            </p>
          </div>
        </div>

        <p class="withdraw-status-detail text-body-m">
          {{ pendingBlockedReason ?? presentation.detail }}
        </p>

        <ol v-if="!pendingBlockedReason" class="withdraw-steps" aria-label="Withdrawal progress">
          <li
            v-for="step in presentation.steps"
            :key="step.key"
            class="withdraw-step text-caption"
            :class="`withdraw-step-${step.state}`"
          >
            <span aria-hidden="true" />
            {{ step.label }}
          </li>
        </ol>

        <details v-if="details.length > 0" class="withdraw-details-shell">
          <summary class="text-label-m font-semibold">Technical details</summary>
          <dl class="withdraw-details">
            <div v-for="row in details" :key="row.key" class="withdraw-detail-row">
              <dt class="text-caption">{{ row.label }}</dt>
              <dd class="text-body-m" :class="{ 'withdraw-mono': row.mono }">
                <span>{{ row.value }}</span>
                <button
                  v-if="row.copy"
                  type="button"
                  class="withdraw-icon-button"
                  :aria-label="`Copy ${row.label}`"
                  @click="copyDetail(row.value)"
                >
                  <Check
                    v-if="copied && copiedValue === row.value"
                    class="size-4"
                    aria-hidden="true"
                  />
                  <Copy v-else class="size-4" aria-hidden="true" />
                </button>
              </dd>
            </div>
          </dl>
        </details>

        <div v-if="activeJob?.account" class="withdraw-secret">
          <div class="withdraw-secret-heading">
            <KeyRound class="size-4" aria-hidden="true" />
            <span class="text-heading-s">Recovery key</span>
          </div>
          <p class="text-caption text-fg-secondary">
            Reveal only if you need to recover the disposable withdrawal account.
          </p>
          <div v-if="revealedSeed" class="withdraw-seed">
            <code>{{ revealedSeed.seedHex }}</code>
            <button
              type="button"
              class="withdraw-icon-button"
              aria-label="Copy recovery key"
              @click="copyDetail(revealedSeed.seedHex)"
            >
              <Check
                v-if="copied && copiedValue === revealedSeed.seedHex"
                class="size-4"
                aria-hidden="true"
              />
              <Copy v-else class="size-4" aria-hidden="true" />
            </button>
          </div>
          <p v-if="revealError" class="withdraw-error text-caption" role="alert">
            {{ revealError }}
          </p>
          <button
            type="button"
            class="withdraw-secondary text-label-m font-semibold"
            :disabled="revealing"
            @click="revealedSeed ? hideSeed() : revealSeed()"
          >
            <EyeOff v-if="revealedSeed" class="size-4" aria-hidden="true" />
            <Eye v-else class="size-4" aria-hidden="true" />
            {{ revealedSeed ? "Hide key" : revealing ? "Revealing…" : "Reveal key" }}
          </button>
        </div>

        <p v-if="workerError" class="withdraw-error text-caption" role="alert">
          {{ workerError }}
        </p>

        <button
          v-if="canResume"
          type="button"
          class="withdraw-primary text-label-l font-semibold"
          :disabled="resuming"
          @click="resumeWithdrawal"
        >
          {{ resuming ? "Resuming…" : "Resume withdrawal" }}
        </button>

        <button
          v-else-if="pendingBlockedReason"
          type="button"
          class="withdraw-primary text-label-l font-semibold"
          @click="retryInitialization"
        >
          Retry
        </button>
      </section>

      <section
        v-if="!pending && (!activeJob || isTerminalWithdraw(activeJob))"
        class="withdraw-form"
      >
        <div class="withdraw-balance">
          <span class="text-caption text-fg-secondary">Private CASH available</span>
          <strong class="text-heading-s text-fg-primary">{{ availableLabel }}</strong>
        </div>
        <p class="withdraw-destination text-body-m">
          Receive pUSD on Asset Hub. Network costs are deducted before arrival.
        </p>

        <div ref="amountRow" class="withdraw-amount" aria-live="polite">
          <span ref="amountValue" class="text-display-xl"
            >{{ displayAmount }}<span class="withdraw-caret" aria-hidden="true"
          /></span>
          <span ref="amountAsset" class="text-display-xl">CASH</span>
        </div>

        <p
          class="withdraw-amount-message text-body-m"
          :class="{
            'withdraw-amount-error': amountState.kind !== 'empty' && amountState.kind !== 'valid',
          }"
          aria-live="polite"
        >
          {{ amountMessage }}
        </p>
        <button
          v-if="balanceError"
          type="button"
          class="withdraw-inline-retry text-label-m font-semibold"
          @click="subscribeBalance"
        >
          Retry balance
        </button>

        <div class="withdraw-keypad" aria-label="Amount keypad">
          <template v-for="(row, rowIndex) in keypad" :key="rowIndex">
            <button
              v-for="key in row"
              :key="key"
              type="button"
              class="text-heading-xl"
              :aria-label="key === 'delete' ? 'Delete digit' : `Enter ${key}`"
              @click="enter(key)"
            >
              <Delete v-if="key === 'delete'" class="size-6" aria-hidden="true" />
              <span v-else>{{ key }}</span>
            </button>
          </template>
        </div>

        <button
          type="button"
          class="withdraw-primary text-label-l font-semibold"
          :disabled="!canWithdraw"
          @click="startWithdrawal"
        >
          {{ starting ? "Starting withdrawal…" : "Withdraw" }}
        </button>
      </section>
    </section>
  </main>
</template>

<style scoped>
.withdraw-screen {
  position: fixed;
  top: var(--vvt, 0px);
  right: 0;
  left: 0;
  display: flex;
  width: 100%;
  max-width: 24.125rem;
  height: var(--vvh, 100dvh);
  margin: 0 auto;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface-main);
  color: var(--fg-primary);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}

.withdraw-scroll {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.5rem 1.125rem 0.875rem;
}

.withdraw-status,
.withdraw-form {
  display: flex;
  width: 100%;
  flex-direction: column;
}

.withdraw-status {
  gap: 1rem;
  border-radius: var(--radius-container);
  background: var(--bg-surface-container);
  box-shadow: var(--shadow-1);
  padding: 1rem;
}

.withdraw-status-unavailable {
  order: 1;
}

.withdraw-status-heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.withdraw-status-icon {
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-nested);
  color: var(--fg-secondary);
}

.withdraw-status-icon-success {
  color: var(--fg-success);
}

.withdraw-status-icon-working svg {
  animation: withdraw-spin 1.1s linear infinite;
}

.withdraw-status-icon-error {
  color: var(--fg-error);
}

.withdraw-status-icon-unknown {
  color: var(--fg-warning, var(--fg-secondary));
}

@keyframes withdraw-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .withdraw-status-icon-working svg {
    animation: none;
  }
}

.withdraw-status-detail {
  color: var(--fg-secondary);
}

.withdraw-steps {
  display: grid;
  gap: 0.5rem;
}

.withdraw-step {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--fg-secondary);
}

.withdraw-step span {
  width: 0.625rem;
  height: 0.625rem;
  flex: none;
  border-radius: 9999px;
  background: var(--bg-action-disabled);
}

.withdraw-step-done span {
  background: var(--fg-success);
}

.withdraw-step-current {
  color: var(--fg-primary);
}

.withdraw-step-current span {
  background: var(--bg-action-primary);
}

.withdraw-step-failed span {
  background: var(--fg-error);
}

.withdraw-step-unknown span {
  background: var(--fg-warning, var(--fg-secondary));
}

.withdraw-details {
  display: grid;
  gap: 0.625rem;
  margin-top: 0.75rem;
}

.withdraw-details-shell {
  border-top: 1px solid var(--stroke-secondary);
  padding-top: 0.875rem;
}

.withdraw-details-shell summary {
  cursor: pointer;
  color: var(--fg-primary);
}

.withdraw-detail-row {
  min-width: 0;
}

.withdraw-detail-row dt {
  color: var(--fg-tertiary);
}

.withdraw-detail-row dd {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  color: var(--fg-primary);
}

.withdraw-detail-row dd > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.withdraw-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.8125rem;
  line-height: 1.35;
}

.withdraw-icon-button {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-action-tertiary);
  color: var(--fg-primary);
}

.withdraw-secret {
  display: grid;
  gap: 0.625rem;
  border-top: 1px solid var(--stroke-secondary);
  padding-top: 1rem;
}

.withdraw-secret-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.withdraw-seed {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  border-radius: var(--radius-s);
  background: var(--bg-surface-nested);
  padding: 0.75rem;
}

.withdraw-seed code {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.75rem;
  line-height: 1.35;
}

.withdraw-balance {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.withdraw-balance strong {
  min-width: 0;
  text-align: right;
}

.withdraw-destination {
  margin-top: 0.75rem;
  color: var(--fg-secondary);
  text-align: center;
}

.withdraw-amount {
  --amount-scale: 1;
  --amount-size: 3.5rem;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: baseline;
  justify-content: center;
  gap: 1rem;
  margin-top: 1.25rem;
  white-space: nowrap;
}

.withdraw-amount > span {
  flex: none;
  font-size: calc(var(--amount-size) * var(--amount-scale));
  line-height: 1.4286;
}

.withdraw-caret {
  display: inline-block;
  width: 0.036em;
  height: 1em;
  border-radius: 9999px;
  background: currentColor;
  vertical-align: -0.11em;
  animation: withdraw-caret-blink 1.1s step-end infinite;
}

@keyframes withdraw-caret-blink {
  0%,
  49% {
    opacity: 1;
  }

  50%,
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .withdraw-caret {
    animation: none;
  }
}

.withdraw-amount-message {
  min-height: 1.25rem;
  color: var(--fg-secondary);
  text-align: center;
}

.withdraw-amount-error,
.withdraw-error {
  color: var(--fg-error);
}

.withdraw-inline-retry {
  align-self: center;
  border-radius: 9999px;
  background: var(--bg-action-tertiary);
  padding: 0.5rem 0.875rem;
  color: var(--fg-primary);
}

.withdraw-keypad {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 1.5rem;
  margin-bottom: 1.5rem;
}

.withdraw-keypad button {
  display: flex;
  height: 3.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--fg-primary);
  transition: background-color 120ms ease-out;
}

.withdraw-keypad button:hover {
  background: var(--bg-selection-container-hover);
}

.withdraw-keypad button:active {
  background: var(--bg-surface-main);
  box-shadow: inset 0 0 0 1px var(--stroke-primary);
}

.withdraw-primary,
.withdraw-secondary {
  display: inline-flex;
  width: 100%;
  height: 3rem;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border-radius: 9999px;
  transition: background-color 120ms ease-out;
}

.withdraw-primary {
  margin-top: auto;
  background: var(--bg-action-primary);
  color: var(--fg-primary-inverted);
}

.withdraw-primary:hover:not(:disabled) {
  background: var(--bg-action-primary-hover);
}

.withdraw-primary:disabled,
.withdraw-secondary:disabled {
  background: var(--bg-action-disabled);
  color: var(--fg-disabled);
}

.withdraw-secondary {
  background: var(--bg-action-tertiary);
  color: var(--fg-primary);
}

.withdraw-secondary:hover:not(:disabled) {
  background: var(--bg-action-tertiary-hover);
}

@media (max-height: 650px) {
  .withdraw-scroll {
    padding-bottom: 0.75rem;
  }

  .withdraw-amount {
    --amount-size: 3rem;
    margin-top: 0.75rem;
  }

  .withdraw-keypad {
    gap: 0.375rem 0.5rem;
    margin-bottom: 0.625rem;
  }

  .withdraw-keypad button {
    height: 2.75rem;
  }
}
</style>
