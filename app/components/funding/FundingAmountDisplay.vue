<script setup lang="ts">
// The big keypad amount: the value in CashAmount's treatment — the symbol on the number, the
// small-caps ticker beside it — and a caret that marks it as live input. The row fits itself to
// the width it has through useAmountFit; the ticker is sized in em, so it rides the same scale.
import { toRef } from "vue";
import CashAmount from "../ui/CashAmount.vue";
import { useAmountFit } from "../../composables/useAmountFit";

const props = withDefaults(
  defineProps<{
    /** The value as it should read, already grouped. */
    amount: string;
    /** The input caret after the digits. Off for a screen that only reports an amount. */
    caret?: boolean;
  }>(),
  { caret: true },
);

const { row: rowEl, value: valueEl } = useAmountFit(toRef(props, "amount"));
</script>

<template>
  <div ref="rowEl" class="amount-display" aria-live="polite">
    <span ref="valueEl" class="amount-display-value text-display-xl">
      <CashAmount :amount="amount">
        <span v-if="caret" class="amount-display-caret" aria-hidden="true" />
      </CashAmount>
    </span>
  </div>
</template>

<style scoped>
.amount-display {
  /* Fluid display type: the amount fits itself to the row, which the fixed
   * type scale cannot express. The span carries the type utility; the only
   * scoped override is the fluid font-size, which re-states the same stop
   * times the fit scale. */
  --amount-scale: 1;
  --amount-size: 3.5rem;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: baseline;
  justify-content: center;
  white-space: nowrap;
}

/* The span keeps its natural width; the fit shrinks the scale. Line height stays fixed. */
.amount-display-value {
  flex: none;
  font-size: calc(var(--amount-size) * var(--amount-scale));
  /* 80/56 as a unitless ratio keeps the same leading at every fluid scale
     (the token's line-height is a fixed 80px). */
  line-height: 1.4286;
}

/* Text-cursor caret after the digits: the keypad is live input. Sized in em so
   it follows the fluid scale; sits inside the digits span so the fit logic
   measures it. currentColor keeps it on fg-primary. */
.amount-display-caret {
  display: inline-block;
  width: 0.036em;
  height: 1em;
  border-radius: 9999px;
  background: currentColor;
  vertical-align: -0.11em;
  animation: amount-display-caret-blink 1.1s step-end infinite;
}

@keyframes amount-display-caret-blink {
  0%,
  49% {
    opacity: 1;
  }

  50%,
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .amount-display-caret {
    animation: none;
  }
}

@media (max-height: 650px) {
  .amount-display {
    /* Short-viewport adaptation of the fluid display size noted above. */
    --amount-size: 3rem;
  }
}
</style>
