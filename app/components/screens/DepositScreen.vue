<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import {
  demoDepositAddress,
  estimateSourceAmount,
  estimateSourceFromCash,
} from "~~/lib/demo-rates";
import { SOURCE_CHAINS } from "~~/lib/config";
import { formatRemaining } from "../../utils/countdown";
import { networkIcon, tokenIcon } from "../../utils/icons";
import { useFlowStore } from "../../stores/flow";
import { useSessionStore } from "../../stores/session";

// The cancel is performed by the route, which unmounts this screen.
const emit = defineEmits<{ cancel: [] }>();

const session = useSessionStore();
const flow = useFlowStore();

const deposit = computed(() => {
  const s = session.lastState;
  return s?.phase === "awaiting-deposit" ? s.deposit : null;
});

// Channel countdown to `deposit.expiresAt`; 0 means no countdown. Display only: the session store
// owns the deadline and fails the top-up when it passes.
const now = ref(Date.now());
const ticker = setInterval(() => (now.value = Date.now()), 1_000);
const remainingMs = computed(() => {
  const at = deposit.value?.expiresAt ?? 0;
  return at > 0 ? at - now.value : null;
});

/** The address the QR and the copy row carry: a source-chain stand-in in the live demo, the real
 *  one in the mock.
 *  TODO(production): carry the real channel address once the Chainflip channel rail lands. */
const address = computed(() => {
  const d = deposit.value;
  if (!d) return "";
  if (!session.live) return d.address;
  return demoDepositAddress(session.quoted?.sourceChain ?? null) ?? d.address;
});

/** How much to send, in the source's own currency: the swap network's figure when it priced this
 *  purchase, the estimate marked ≈ otherwise, the bare native figure when no source is chosen. */
const amount = computed(() => {
  const d = deposit.value;
  if (!d) return "";
  const q = session.quoted;
  const priced = session.sourcePrice;
  if (priced?.kind === "price" && q?.sourceAsset) {
    return `${priced.price.formatted} ${q.sourceAsset}`;
  }
  // TODO(production): the branches below the precise price are demo conveniences; remove them with
  // the faucet and the estimateSource* helpers.
  // Below the floor: the floor quote's rate, scaled linearly to this purchase.
  if (priced?.kind === "minimum") {
    return `≈ ${priced.minimum.neededFormatted} ${priced.minimum.assetSymbol}`;
  }
  if (q?.send && q.symbol === q.sourceAsset) {
    return q.send.endsWith(q.symbol) ? q.send : `${q.send} ${q.symbol}`;
  }
  if (session.live && q?.sourceAsset) {
    const estimate = estimateSourceAmount(d.amount, q.sourceAsset);
    if (estimate) return `≈ ${estimate} ${q.sourceAsset}`;
  }
  // The browser world's estimate scales from the CASH amount.
  if (!session.live && q?.sourceAsset && session.amountBase !== null) {
    const estimate = estimateSourceFromCash(session.amountBase, q.sourceAsset);
    if (estimate) return `≈ ${estimate} ${q.sourceAsset}`;
  }
  return d.formatted.endsWith(d.assetSymbol) ? d.formatted : `${d.formatted} ${d.assetSymbol}`;
});
const compactAmount = computed(() => amount.value.length > 10);

const source = computed(() => {
  const chainName = session.quoted?.sourceChain ?? flow.srcChain.chain;
  const chain = SOURCE_CHAINS.find((candidate) => candidate.chain === chainName) ?? flow.srcChain;
  const asset = session.quoted?.sourceAsset ?? flow.srcAsset;
  return { chain, asset };
});

// Cancel. The button opens the confirmation sheet and the sheet's red pill performs the cancel.
// Offered only while nothing has been paid.
const confirmingCancel = ref(false);
const showCancel = computed(() => session.faucetState === "idle" && !session.fundsSeen);
function dismissCancelSheet() {
  // The sheet stays up mid-cancel.
  if (!session.cancelling) confirmingCancel.value = false;
}
function confirmCancel() {
  if (session.cancelling) return;
  emit("cancel");
}
// Closes the sheet when a declined cancel finishes with this screen still mounted.
watch(
  () => session.cancelling,
  (now, before) => {
    if (before && !now) confirmingCancel.value = false;
  },
);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copy() {
  if (!address.value) return;
  try {
    await navigator.clipboard.writeText(address.value);
    copied.value = true;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    console.warn("[deposit] clipboard write failed:", e);
  }
}
onUnmounted(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  clearInterval(ticker);
});
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <!-- The one flexible block on the screen. Short webviews shrink the QR to a scannable
         floor. -->
    <div v-if="address" class="flex min-h-24 shrink basis-44 justify-center pt-2 pb-1">
      <QrCard :value="address" />
    </div>

    <p class="mt-3 shrink-0 text-center text-base leading-6 text-text-secondary">
      Send this exact amount
    </p>
    <p
      class="mt-1 shrink-0 text-center leading-[1.15] font-semibold tracking-[-1px] whitespace-nowrap"
      :class="compactAmount ? 'text-[clamp(2rem,9vw,2.25rem)]' : 'text-[clamp(2.25rem,12vw,3rem)]'"
    >
      {{ amount }}
    </p>

    <button
      type="button"
      class="mt-3 flex shrink-0 items-center justify-between gap-3 rounded-2xl bg-surface-container py-3 pr-6 pl-4 text-left"
      @click="copy"
    >
      <span class="min-w-0 flex-1">
        <span class="block text-xs leading-4 text-text-secondary">To address</span>
        <span class="mt-0.5 block max-w-full text-sm leading-5 break-all text-text-primary">{{
          address
        }}</span>
      </span>
      <img :src="copied ? '/icons/check.svg' : '/icons/copy.svg'" alt="" class="size-6 shrink-0" />
    </button>

    <dl class="mt-6 flex shrink-0 flex-col gap-4">
      <div class="flex min-h-6 items-center justify-between gap-4">
        <dt class="flex min-w-0 items-center gap-2 text-base leading-6">
          <img :src="networkIcon(source.chain.chain)" alt="" class="size-6 shrink-0 rounded-full" />
          <span>Network</span>
        </dt>
        <dd class="min-w-0 truncate text-base leading-6 font-semibold">
          {{ source.chain.label }}
        </dd>
      </div>
      <div class="flex min-h-6 items-center justify-between gap-4">
        <dt class="flex min-w-0 items-center gap-2 text-base leading-6">
          <img :src="tokenIcon(source.asset)" alt="" class="size-6 shrink-0 rounded-full" />
          <span>Currency</span>
        </dt>
        <dd class="min-w-0 truncate text-base leading-6 font-semibold">{{ source.asset }}</dd>
      </div>
      <div v-if="remainingMs !== null" class="flex min-h-6 items-center justify-between gap-4">
        <dt class="flex min-w-0 items-center gap-2 text-base leading-6">
          <span
            class="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-container"
          >
            <img src="/icons/clock.svg" alt="" class="size-4" />
          </span>
          <span>Expires in</span>
        </dt>
        <dd class="min-w-0 truncate text-base leading-6 font-semibold tabular-nums">
          {{ formatRemaining(remainingMs) }}
        </dd>
      </div>
    </dl>

    <!-- Cancel opens the confirmation sheet and is offered only while nothing has been paid. -->
    <div class="mt-auto grid shrink-0 grid-cols-2 gap-2 pt-6">
      <button
        v-if="showCancel"
        type="button"
        class="h-12 rounded-full bg-[#e7333f] text-base leading-6 font-semibold text-white"
        @click="confirmingCancel = true"
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex h-12 items-center justify-center gap-2 rounded-full bg-action-secondary px-2 text-[15px] leading-6 font-semibold whitespace-nowrap text-text-primary disabled:opacity-100"
        :class="showCancel ? '' : 'col-span-2'"
        disabled
      >
        <span
          class="size-4 shrink-0 animate-spin rounded-full border-[1.5px] border-text-secondary border-r-transparent"
          aria-hidden="true"
        />
        <span>Waiting for funds</span>
      </button>
    </div>

    <BottomSheet :open="confirmingCancel" @dismiss="dismissCancelSheet">
      <div class="flex flex-col gap-2 px-6 py-4 text-center">
        <p class="text-2xl leading-8 font-semibold">Cancel this top-up?</p>
        <p class="text-base leading-5">
          The deposit address will stop working. Don't cancel if you've already sent your funds.
        </p>
      </div>
      <div class="flex flex-col gap-4 p-4">
        <button
          type="button"
          class="h-12 w-full rounded-full bg-error text-base leading-6 font-semibold text-white disabled:opacity-50"
          :disabled="session.cancelling"
          @click="confirmCancel"
        >
          {{ session.cancelling ? "Cancelling…" : "Cancel" }}
        </button>
        <button
          type="button"
          class="h-12 w-full rounded-full bg-action-secondary text-base leading-6 font-semibold disabled:opacity-50"
          :disabled="session.cancelling"
          @click="dismissCancelSheet"
        >
          Keep it
        </button>
      </div>
    </BottomSheet>
  </section>
</template>
