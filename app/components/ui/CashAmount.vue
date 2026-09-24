<script setup lang="ts">
// A CASH sum as the designs draw it, everywhere one is drawn: the dollar sign on the number, the
// ticker after it in small caps. The one place the treatment changes. Prose that can only carry a
// string keeps `cashAmount()` from utils/cash, which writes the same form without the styling.
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
/* The ticker's small caps: half the surrounding size, but only on the display sizes — scaled
   below 16px it stops being legible, so where 50% would land under that the ticker stays at the
   figure's own size. max(0.5em, min(1em, 1rem)) says exactly that: 0.5em while it clears 16px,
   capped at the surrounding size for the small styles. In em so it follows whatever type the sum
   sits in, including the amount screen's fluid scale. Lighter than the figure either way, and the
   tracking resets the display styles' negative letter-spacing, which reads cramped on a shrunken
   ticker. */
.cash-ticker {
  margin-left: 0.35em;
  font-size: max(0.5em, min(1em, 1rem));
  font-weight: var(--scale-font-weight-regular);
  letter-spacing: 0.03em;
}
</style>
