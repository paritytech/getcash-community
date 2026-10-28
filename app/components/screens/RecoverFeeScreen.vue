<script setup lang="ts">
// The confirmation before the purse is asked for a trapped top-up's claim fee: what the fee is
// for, what the balance holds, and the fee itself. Confirm asks the host, whose sheet answers
// over this screen; until the host's word reaches the record the screen says the fee is being
// paid, and the route returns to the journey when it does.
import type { PurseWord } from "../../funding/timeline/recovery";
import { cashInText, fmtCash, groupAmountDigits } from "../../utils/cash";
import CashAmount from "../ui/CashAmount.vue";
import PillButton from "../ui/PillButton.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";

defineProps<{
  /** The fee, decimal CASH. */
  fee: string;
  /** The top-up's amount, decimal CASH. */
  amount: string;
  purse: PurseWord;
  /** The purse could not be read and the quick retries are spent; the slow ones go on. */
  purseUnread: boolean;
  /** The read purse falls short of the fee: the host is not asked. */
  short: boolean;
  /** The host is being asked, or its sheet is up. */
  paying: boolean;
  /** A tap the store could not act on, said under the figure. */
  notice: string | null;
}>();
const emit = defineEmits<{ confirm: []; back: [] }>();
</script>

<template>
  <ScreenFrame>
    <div class="flex flex-col gap-2 px-2 text-center">
      <h1 class="text-display-s text-fg-primary">Pay fee</h1>
      <p class="text-paragraph-l text-fg-primary">
        It's needed to add your {{ cashInText(amount) }} to your balance. We'll take it from your
        balance.
      </p>
    </div>

    <div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <!-- The balance the fee comes from: a skeleton while it is read, a word once the read
           keeps failing, nothing where there is no purse to read. -->
      <p v-if="purse === 'unknown' && purseUnread" class="text-body-s text-fg-secondary">
        Your balance couldn't be read. Retrying…
      </p>
      <SkeletonBlock v-else-if="purse === 'unknown'" style="width: 10.5rem; height: 1.75rem" />
      <span
        v-else-if="purse !== 'none'"
        class="rounded-full bg-surface-container px-3 py-1 text-body-m text-fg-secondary"
      >
        Available <CashAmount :amount="groupAmountDigits(fmtCash(purse))" />
      </span>
      <p class="text-display-m text-fg-primary"><CashAmount :amount="fee" /></p>
      <p v-if="short" class="text-body-m text-fg-secondary" role="status">
        Your balance doesn't cover the fee.
      </p>
      <p v-if="notice" class="text-body-m text-fg-secondary" role="status">{{ notice }}</p>
    </div>

    <template #actions>
      <PillButton
        v-if="paying"
        variant="ghost"
        class="flex items-center justify-center gap-2"
        disabled
      >
        <span
          class="size-4 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-primary border-r-transparent"
          aria-hidden="true"
        />
        <span>Paying the fee…</span>
      </PillButton>
      <div v-else class="grid grid-cols-2 gap-2">
        <PillButton variant="secondary" @click="emit('back')">Back</PillButton>
        <PillButton :disabled="short" @click="emit('confirm')">Confirm</PillButton>
      </div>
    </template>
  </ScreenFrame>
</template>
