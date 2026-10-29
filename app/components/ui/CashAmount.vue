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
/* Light secondary small caps on the figure's baseline, half the figure on display styles */
.cash-ticker {
  margin-left: 0.25rem;
  /* Blink and WebKit synthesize small caps at 0.7 of the font size */
  font-size: max(calc(0.5em / 0.7), min(1em, 1rem));
  font-variant-caps: all-small-caps;
  /* The figure alone sets the line, so display amounts keep the design's line height */
  line-height: 0;
  font-weight: var(--scale-font-weight-light);
  color: var(--fg-secondary);
}
</style>
