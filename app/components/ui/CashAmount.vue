<script setup lang="ts">
// A CASH sum as the designs draw it, everywhere one is drawn: the dollar sign on the number, the
// CASH logo after it. Copy carried as a string writes `cashAmount()` and draws it with `<CashText>`.
import { currencyConfig } from "../../funding/config";
import CashLogo from "./CashLogo.vue";

withDefaults(
  defineProps<{
    /** The human amount, already formatted for its context ("50", "226.78", "2,000"). */
    amount: string;
    /** A sign the figure carries ("+" on a credit). */
    sign?: string;
    /** Drops the ticker, for the leading figure of a range ("$10 to $2,000 CASH"). */
    ticker?: boolean;
  }>(),
  { sign: "", ticker: true },
);
</script>

<template>
  <!-- The slot sits between the number and the ticker, for a caret on a live input. -->
  <span class="cash-amount"
    >{{ sign }}{{ currencyConfig.symbol }}{{ amount }}<slot /><CashLogo
      v-if="ticker"
      variant="lockup"
      class="cash-ticker"
  /></span>
</template>

<style scoped>
.cash-ticker {
  margin-left: 0.25rem;
  /* The figure alone sets the line, so display amounts keep the design's line height */
  line-height: 0;
  color: var(--fg-secondary);
}
</style>
