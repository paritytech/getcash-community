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
      ><span class="cash-ticker-text">{{ currencyConfig.ticker }}</span></span
    ></span
  >
</template>

<style scoped>
/* A shrunken ticker sits centered on the digits, not on the baseline: raised by half the
   cap-height difference between the figure and the ticker (cap height ≈ 0.72em in both Manrope
   and Inter, so 0.36 per em of size difference). The offset mirrors the font-size clamp below,
   so it is exactly zero whenever the ticker keeps the figure's size. It lives on this outer
   span — still at the figure's size, where 1em is the figure's em — because inside the shrunken
   text the figure's size is no longer expressible. Relative positioning shifts paint only, so
   the raise can't grow the line box. */
.cash-ticker {
  position: relative;
  top: calc(0.36 * (max(0.5em, min(1em, 1rem)) - 1em));
}

/* The ticker's small caps: half the surrounding size, but only on the display sizes — scaled
   below 16px it stops being legible, so where 50% would land under that the ticker stays at the
   figure's own size. max(0.5em, min(1em, 1rem)) says exactly that: 0.5em while it clears 16px,
   capped at the surrounding size for the small styles. In em so it follows whatever type the sum
   sits in, including the amount screen's fluid scale. Lighter than the figure either way, and the
   tracking resets the display styles' negative letter-spacing, which reads cramped on a shrunken
   ticker. */
.cash-ticker-text {
  margin-left: 0.35em;
  font-size: max(0.5em, min(1em, 1rem));
  font-weight: var(--scale-font-weight-regular);
  letter-spacing: 0.03em;
}
</style>
