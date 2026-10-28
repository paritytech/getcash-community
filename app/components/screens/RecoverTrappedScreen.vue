<script setup lang="ts">
// The deposit that pays a trapped top-up's claim fee: the token the buyer picked, sent to the
// top-up's own Asset Hub account, which the worker converts for the fee as it would a top-up.
// The route hands over the figures: the address is the record's own, the least to send is the
// worker's, and whatever is sent above the fee is added to the Cash.
import { Copy } from "lucide-vue-next";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import type { RecoveryChoice } from "../../funding/recovery-deposit";
import { shortAddress } from "../../utils/address";
import CopiedPill from "../ui/CopiedPill.vue";
import PillButton from "../ui/PillButton.vue";
import QrCard from "../ui/QrCard.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

defineProps<{
  address: string | null;
  /** The picked token with the least to send; null until the worker priced it. */
  choice: RecoveryChoice | null;
  /** The fee as the band names it ("$0.01"); undefined until the worker sized it. */
  fee?: string;
}>();
const emit = defineEmits<{ changeToken: [] }>();

// Either row's copy raises the shared pill above the buttons.
const { copy: copyToClipboard } = useCopyToClipboard();
function copy(text: string | null) {
  if (text) void copyToClipboard(text);
}
</script>

<template>
  <ScreenFrame>
    <template v-if="choice && address">
      <!-- The one flexible block, as on the deposit screen: the QR takes what the rows leave,
           down to a scannable floor. -->
      <div class="flex min-h-24 shrink basis-[19rem] justify-center pb-4">
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

      <p v-if="fee" class="mt-4 shrink-0 text-right text-body-s text-fg-secondary">
        The fee is {{ fee }}. Anything above it is added to your Cash.
      </p>
    </template>
    <!-- The token is not priced: not yet, or not today. The other tokens are a tap away. -->
    <p v-else class="shrink-0 text-center text-body-m text-fg-secondary">
      This token can't be priced right now. Change token, or try again in a moment.
    </p>

    <template #actions>
      <div class="flex flex-col pt-6">
        <CopiedPill />
        <div class="grid grid-cols-2 gap-2">
          <PillButton variant="tertiary" @click="emit('changeToken')">Change token</PillButton>
          <!-- The waiting word is a button in shape only, as on the deposit screen. -->
          <button
            type="button"
            class="flex h-12 items-center justify-center gap-2 rounded-full bg-action-tertiary px-2 text-label-l whitespace-nowrap text-fg-primary disabled:opacity-100"
            role="status"
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
    </template>
  </ScreenFrame>
</template>
