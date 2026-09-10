<script setup lang="ts">
import { computed } from "vue";
import { Check, Copy } from "lucide-vue-next";
import {
  demoDepositAddress,
  estimateSourceAmount,
  estimateSourceFromCash,
} from "~~/lib/demo-rates";
import { SOURCE_CHAINS } from "~~/lib/config";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { shortAddress } from "../../utils/address";
import { useFlowStore } from "../../stores/flow";
import { useSessionStore } from "../../stores/session";

// Cancel is a request: the route swaps in the full-screen confirmation and performs the cancel.
const emit = defineEmits<{ cancel: [] }>();

const session = useSessionStore();
const flow = useFlowStore();

// While the deposit is still being opened this screen renders its skeleton shapes instead.
const deposit = computed(() => {
  const s = session.lastState;
  return s?.phase === "awaiting-deposit" ? s.deposit : null;
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

/** How much to send, split so the copy carries the bare number: the swap network's figure when it
 *  priced this purchase, the estimate marked ≈ otherwise, the bare native figure when no source is
 *  chosen. */
const amount = computed<{ value: string; symbol: string; approx: boolean } | null>(() => {
  const d = deposit.value;
  if (!d) return null;
  const q = session.quoted;
  const priced = session.sourcePrice;
  if (priced?.kind === "price" && q?.sourceAsset) {
    return { value: priced.price.formatted, symbol: q.sourceAsset, approx: false };
  }
  // TODO(production): the branches below the precise price are demo conveniences; remove them with
  // the faucet and the estimateSource* helpers.
  // Below the floor: the floor quote's rate, scaled linearly to this purchase.
  if (priced?.kind === "minimum") {
    return {
      value: priced.minimum.neededFormatted,
      symbol: priced.minimum.assetSymbol,
      approx: true,
    };
  }
  if (q?.send && q.symbol === q.sourceAsset) {
    const bare = q.send.endsWith(q.symbol) ? q.send.slice(0, -q.symbol.length).trim() : q.send;
    return { value: bare, symbol: q.symbol, approx: false };
  }
  if (session.live && q?.sourceAsset) {
    const estimate = estimateSourceAmount(d.amount, q.sourceAsset);
    if (estimate) return { value: estimate, symbol: q.sourceAsset, approx: true };
  }
  // The browser world's estimate scales from the CASH amount.
  if (!session.live && q?.sourceAsset && session.amountBase !== null) {
    const estimate = estimateSourceFromCash(session.amountBase, q.sourceAsset);
    if (estimate) return { value: estimate, symbol: q.sourceAsset, approx: true };
  }
  const bare = d.formatted.endsWith(d.assetSymbol)
    ? d.formatted.slice(0, -d.assetSymbol.length).trim()
    : d.formatted;
  return { value: bare, symbol: d.assetSymbol, approx: false };
});
const amountText = computed(() => {
  const a = amount.value;
  return a ? `${a.approx ? "≈ " : ""}${a.value} ${a.symbol}` : "";
});

const source = computed(() => {
  const chainName = session.quoted?.sourceChain ?? flow.srcChain.chain;
  const chain = SOURCE_CHAINS.find((candidate) => candidate.chain === chainName) ?? flow.srcChain;
  const asset = session.quoted?.sourceAsset ?? flow.srcAsset;
  return { chain, asset };
});

// Cancel is offered only while nothing has been paid.
const showCancel = computed(() => session.faucetState === "idle" && !session.fundsSeen);

// The "Copied" pill above the buttons answers either row's copy.
const { copied, copy: copyToClipboard } = useCopyToClipboard();
function copy(target: "amount" | "address") {
  const text = target === "amount" ? amount.value?.value : address.value;
  if (text) void copyToClipboard(text);
}
</script>

<template>
  <!-- The deposit is still being opened: the screen's own shapes as placeholders. -->
  <section v-if="!deposit" class="flex min-h-0 flex-1 flex-col" aria-label="Opening your top-up">
    <div class="flex min-h-24 shrink basis-[19rem] justify-center pb-4">
      <span class="aspect-square h-full max-h-72 animate-pulse rounded-container bg-surface-container" />
    </div>
    <div v-for="n in 2" :key="n" class="flex h-16 shrink-0 items-center justify-between gap-4">
      <span class="flex min-w-0 flex-col gap-1.5">
        <span class="h-3 w-28 animate-pulse rounded-full bg-action-disabled" />
        <span class="h-4 w-40 animate-pulse rounded-full bg-action-disabled" />
      </span>
      <span class="size-6 shrink-0 animate-pulse rounded-full bg-action-disabled" />
    </div>
    <div class="mt-auto grid shrink-0 grid-cols-2 gap-2 pt-6 pb-6">
      <span class="h-12 animate-pulse rounded-full bg-surface-container" />
      <span class="h-12 animate-pulse rounded-full bg-surface-container" />
    </div>
  </section>

  <section v-else class="flex min-h-0 flex-1 flex-col">
    <!-- The one flexible block on the screen. Short webviews shrink the QR to a scannable
         floor. The basis carries the card's 288px plus this block's own 16px bottom gap. -->
    <div class="flex min-h-24 shrink basis-[19rem] justify-center pb-4">
      <QrCard :value="address" />
    </div>

    <!-- Each row copies its value; the pill above the buttons confirms. -->
    <button
      type="button"
      class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-stroke-primary text-left"
      @click="copy('amount')"
    >
      <span class="min-w-0">
        <span class="block text-body-s text-fg-secondary">Send this exact amount</span>
        <span class="mt-1 block truncate text-paragraph-l text-fg-primary">{{ amountText }}</span>
      </span>
      <Copy class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
    </button>

    <button
      type="button"
      class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-stroke-primary text-left"
      @click="copy('address')"
    >
      <span class="min-w-0">
        <span class="block text-body-s text-fg-secondary">
          <!-- The network stands out by weight alone; the design keeps the label's own grey. -->
          To this address on
          <span class="font-semibold">{{ source.chain.label }} Network</span>
        </span>
        <span class="mt-1 block truncate text-paragraph-l text-fg-primary">
          {{ shortAddress(address) }}
        </span>
      </span>
      <Copy class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
    </button>

    <div class="mt-auto flex shrink-0 flex-col pt-6 pb-6">
      <div v-if="copied" class="flex justify-center pb-3" aria-live="polite">
        <span
          class="flex items-center gap-2 rounded-full bg-surface-container px-4 py-2 text-label-m text-fg-primary shadow-1"
        >
          <Check class="size-4 text-fg-success" aria-hidden="true" />
          Copied
        </span>
      </div>
      <!-- Cancel asks the route for the confirmation screen; offered only while nothing has
           been paid. -->
      <div class="grid grid-cols-2 gap-2">
        <button
          v-if="showCancel"
          type="button"
          class="h-12 rounded-full bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-12 items-center justify-center gap-2 rounded-full bg-action-tertiary px-2 text-label-l whitespace-nowrap text-fg-primary disabled:opacity-100"
          :class="showCancel ? '' : 'col-span-2'"
          disabled
        >
          <span
            class="size-4 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-primary border-r-transparent"
            aria-hidden="true"
          />
          <span>Waiting for funds</span>
        </button>
      </div>
    </div>

  </section>
</template>
