<script setup lang="ts">
// The manual way to the claim's fee for a top-up whose Cash is in People's trap: a deposit of any
// token a top-up takes, on the top-up's own Asset Hub account, which the worker converts for the
// fee as it would a top-up. The least of each token comes from the worker; the address is the
// record's own.
import { computed, ref } from "vue";
import { Copy } from "lucide-vue-next";
import { TOKENS } from "@getsome/core";
import { directAssetName, type RecoveryToken } from "@getsome/funding";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { useRequestsStore } from "../../stores/requests";
import { shortAddress } from "../../utils/address";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";
import QrCard from "../ui/QrCard.vue";

const emit = defineEmits<{ back: [] }>();
const requests = useRequestsStore();

const record = computed(() => requests.foregroundRecord);
// A record rebuilt from the worker's job keeps the address outside its deposit block.
const address = computed(
  () =>
    record.value?.handoff?.burnerAddress ??
    record.value?.deposit?.address ??
    record.value?.depositAddress ??
    null,
);

const TOKEN_ORDER: readonly RecoveryToken[] = ["PAS", "DOTUSD", "USDT", "USDC"];

/** Base units as a decimal, trailing zeros trimmed. */
function fmtUnits(base: bigint, decimals: number): string {
  const s = base.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "") || "0";
}

/** The tokens the worker priced, each with the least to send, named as the deposit screen names
 *  them. */
const choices = computed(() => {
  const minimums = record.value?.recovery?.minimums ?? {};
  return TOKEN_ORDER.flatMap((token) => {
    const figure = minimums[token];
    if (typeof figure !== "string") return [];
    const spec = TOKENS[token];
    return [
      { token, name: directAssetName(spec), amount: fmtUnits(BigInt(figure), spec.decimals) },
    ];
  });
});
const picked = ref<RecoveryToken | null>(null);
const choice = computed(
  () => choices.value.find((c) => c.token === picked.value) ?? choices.value[0] ?? null,
);

// Either row's copy raises the shared pill above the buttons.
const { copy: copyToClipboard } = useCopyToClipboard();
function copy(text: string | null) {
  if (text) void copyToClipboard(text);
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6" aria-label="Recover your Cash">
    <!-- The toolbar carries the title, so the screen opens on what to do and the QR keeps its
         room, as on the deposit screen. -->
    <p class="shrink-0 text-center text-paragraph-l text-fg-primary">
      Send a little to cover the recovery fee. The rest comes back with your Cash.
    </p>

    <!-- The token to send: a row of chips, the picked one filled. -->
    <div
      v-if="choices.length"
      class="mt-6 flex shrink-0 flex-wrap justify-center gap-2"
      role="radiogroup"
      aria-label="Token to send"
    >
      <button
        v-for="c in choices"
        :key="c.token"
        type="button"
        role="radio"
        :aria-checked="choice?.token === c.token"
        class="rounded-full px-3 py-1 text-label-m transition-colors"
        :class="
          choice?.token === c.token
            ? 'bg-action-primary text-fg-primary-inverted'
            : 'bg-action-tertiary text-fg-primary hover:bg-action-tertiary-hover'
        "
        @click="picked = c.token"
      >
        {{ c.name }}
      </button>
    </div>
    <p v-else class="mt-6 shrink-0 text-center text-body-m text-fg-secondary">
      Working out what to send. Try again in a moment.
    </p>

    <template v-if="choice && address">
      <!-- The one flexible block, as on the deposit screen: the QR takes what the text leaves,
           up to 224px so the chips and rows around it keep their weight. -->
      <div class="mt-6 flex min-h-24 shrink basis-[15rem] justify-center pb-4">
        <QrCard :value="address" />
      </div>

      <!-- Each row copies its value; the pill above the buttons confirms. -->
      <button
        type="button"
        class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-stroke-primary text-left"
        @click="copy(choice.amount)"
      >
        <span class="min-w-0">
          <span class="block text-body-s text-fg-secondary">Send at least</span>
          <span class="mt-1 block truncate text-paragraph-l text-fg-primary">
            {{ choice.amount }} {{ choice.name }}
          </span>
        </span>
        <Copy class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-stroke-primary text-left"
        @click="copy(address)"
      >
        <span class="min-w-0">
          <span class="block text-body-s text-fg-secondary">
            To this address on <span class="font-semibold">Polkadot Asset Hub</span>
          </span>
          <span class="mt-1 block truncate text-paragraph-l text-fg-primary">
            {{ shortAddress(address) }}
          </span>
        </span>
        <Copy class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
      </button>

      <p class="mt-4 shrink-0 text-body-s text-fg-secondary">
        For privacy, send from an account you don't use for other top-ups.
      </p>
    </template>

    <!-- The waiting word is a status line, not a second button: Back is the only action. -->
    <div class="mt-auto flex shrink-0 flex-col gap-2 pt-6">
      <CopiedPill />
      <p class="flex items-center justify-center gap-2 text-body-m text-fg-secondary" role="status">
        <span
          class="size-4 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-secondary border-r-transparent"
          aria-hidden="true"
        />
        <span>Waiting for funds</span>
      </p>
      <PillButton variant="tertiary" class="w-full" @click="emit('back')">Back</PillButton>
    </div>
  </section>
</template>
