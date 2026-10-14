<script setup lang="ts">
// A CASH sum as the designs draw it, everywhere one is drawn: the dollar sign on the number, the
// ticker after it in light secondary small caps. The one place the treatment changes. Prose that
// can only carry a string keeps `cashAmount()` from utils/cash, which writes the same form without the styling.
import { currencyConfig } from "../../funding/config";

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
    >{{ sign }}{{ currencyConfig.symbol }}{{ amount }}<slot /><span
      v-if="ticker"
      class="cash-ticker"
      >{{ currencyConfig.ticker }}</span
    ></span
  >
</template>

<style scoped>
/* Small caps on the figure's baseline: half the surrounding size on display styles, never below
   16px (where it keeps the figure's size). Light, secondary, and the figure's own tracking. */
.cash-ticker {
  margin-left: 0.25rem;
  font-size: max(0.5em, min(1em, 1rem));
  font-weight: var(--scale-font-weight-light);
  color: var(--fg-secondary);
}
</style>
