<script setup lang="ts">
// The purse offered as an amount the keypad can take: a tap fills the amount with it. Undefined
// renders nothing (no purse to offer), null the skeleton while the balance is read; the screen's
// launch skeleton mutes a purse it already has. Layout (margins) belongs to the call site, so the
// screen's own class rides whichever branch renders.
import CashAmount from "../ui/CashAmount.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import { groupAmountDigits } from "../../utils/cash";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** The purse as an amount string; null while it loads, undefined where there is none. */
    amount?: string | null;
    skeleton?: boolean;
  }>(),
  { amount: undefined, skeleton: false },
);

const emit = defineEmits<{ fill: [amount: string] }>();
</script>

<template>
  <SkeletonBlock
    v-if="amount === null || (skeleton && amount !== undefined)"
    v-bind="$attrs"
    style="width: 10.5rem; height: 1.75rem"
  />
  <button
    v-else-if="amount !== undefined"
    v-bind="$attrs"
    type="button"
    class="available-pill text-label-m"
    @click="emit('fill', amount)"
  >
    Available <CashAmount :amount="groupAmountDigits(amount)" />
  </button>
</template>

<style scoped>
.available-pill {
  height: 1.75rem;
  border-radius: 9999px;
  background: var(--bg-surface-nested);
  padding: 0 0.75rem;
  color: var(--fg-secondary);
  white-space: nowrap;
  transition: background-color 120ms ease-out;
}

.available-pill:hover {
  background: var(--bg-selection-container-hover);
}
</style>
