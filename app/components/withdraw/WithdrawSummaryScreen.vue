<script setup lang="ts">
// The summary before the purse is asked: the amount leaving the balance, an estimate of what
// arrives, and where. The hero's caption opens the fee drill-in when the quote brought a split.
// Confirm starts the withdrawal.
import { ChevronRight } from "lucide-vue-next";
import { shortAddress, type WithdrawDestination } from "../../withdraw/destinations";
import type { WithdrawFeeView } from "../../withdraw/offers";
import { groupAmountDigits } from "../../utils/cash";
import CashAmount from "../ui/CashAmount.vue";
import PillButton from "../ui/PillButton.vue";

defineProps<{
  /** The CASH leaving the balance, as typed. */
  amount: string;
  destination: WithdrawDestination;
  address: string;
  /** What arrives, already formatted; null while the quote is in flight; undefined when there is
   *  no quote for this destination. */
  receive: string | null | undefined;
  /** The quote's fee split; null when it brought none, which keeps the caption a plain line. */
  fees: WithdrawFeeView | null;
  starting: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ confirm: []; fees: [] }>();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col items-center text-center">
      <p class="text-display-m text-fg-primary">
        <CashAmount :amount="groupAmountDigits(amount)" />
      </p>
      <button
        v-if="fees"
        type="button"
        class="mt-1 flex items-center gap-2 text-body-m text-fg-secondary"
        @click="emit('fees')"
      >
        From your balance inc. fees
        <ChevronRight class="size-4" aria-hidden="true" />
      </button>
      <p v-else class="mt-1 text-body-m text-fg-secondary">From your balance inc. fees</p>
    </div>

    <dl class="mt-8 flex flex-col gap-4">
      <div v-if="receive !== undefined" class="flex items-baseline justify-between gap-4">
        <dt class="text-paragraph-l text-fg-primary">You'll receive</dt>
        <dd class="text-heading-m text-fg-primary">
          <span
            v-if="receive === null"
            class="inline-block h-5 w-24 animate-pulse rounded-small bg-surface-container"
          />
          <template v-else>{{ receive }}</template>
        </dd>
      </div>
      <div class="flex items-baseline justify-between gap-4">
        <dt class="text-paragraph-l text-fg-primary">
          To this address<br />
          on <strong class="font-semibold">{{ destination.chainLabel }} Network</strong>
        </dt>
        <dd class="text-heading-m text-fg-primary" :title="address">{{ shortAddress(address) }}</dd>
      </div>
    </dl>

    <p v-if="error" class="mt-4 text-body-s text-fg-error" role="alert">{{ error }}</p>

    <PillButton class="mt-auto mb-6 w-full" :disabled="starting" @click="emit('confirm')">
      {{ starting ? "Confirming…" : "Confirm withdrawal" }}
    </PillButton>
  </div>
</template>
