<script setup lang="ts">
import { currencyConfig } from "../../funding/config";

defineProps<{
  /** `lockup` after a figure, `word` within a sentence. */
  variant: "lockup" | "word";
}>();

const GLYPH = { lockup: "c", word: "C" } as const;
</script>

<template>
  <!-- The font draws the whole wordmark for one letter: lowercase for the small-caps lockup,
       uppercase for the word. Assistive technology reads the ticker instead. -->
  <span
    ><span aria-hidden="true" :class="['cash-logo', `cash-logo-${variant}`]">{{
      GLYPH[variant]
    }}</span
    ><span class="sr-only">{{ currencyConfig.ticker }}</span></span
  >
</template>

<style scoped>
.cash-logo {
  font-family: "Cash Logo";
  font-weight: 400;
  font-style: normal;
  font-synthesis: none;
  letter-spacing: normal;
}

/* The lockup's wordmark stands at 60% of the figure's height: 0.6 × Inter's 0.7275em digits
 * over the glyph's 0.511em. */
.cash-logo-lockup {
  font-size: 0.854em;
}
</style>
