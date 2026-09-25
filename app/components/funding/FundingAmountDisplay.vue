<script setup lang="ts">
// The big keypad amount in CashAmount's treatment, with a caret marking live input. The row
// fits itself to its width through useAmountFit.
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
  /* Fluid display type: the fit scale multiplies into the fixed stop; the ticker inside is
   * em-sized, so it rides the same scale. */
  --amount-scale: 1;
  --amount-size: 3.5rem;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: baseline;
  justify-content: center;
  white-space: nowrap;
}

/* The span keeps its natural width; the fit shrinks the scale. */
.amount-display-value {
  flex: none;
  font-size: calc(var(--amount-size) * var(--amount-scale));
  /* 80/56 keeps the token's fixed 80px leading at every fluid scale. */
  line-height: 1.4286;
}

/* Caret after the digits, inside the measured span; em-sized so it follows the scale. */
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
    --amount-size: 3rem;
  }
}
</style>
