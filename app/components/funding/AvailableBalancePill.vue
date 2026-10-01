<script setup lang="ts">
// A tap fills the keypad with the purse balance. The base units become a string only here, so
// the gate and the pill can never read the purse apart.
import { computed } from "vue";
import CashAmount from "../ui/CashAmount.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
import { cashToAmountInput, groupAmountDigits } from "../../utils/cash";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** The purse in base units of CASH; null while it loads, undefined where there is none. */
    amount?: bigint | null;
    decimals: number;
    skeleton?: boolean;
  }>(),
  { amount: undefined, skeleton: false },
);

const emit = defineEmits<{ fill: [amount: string] }>();

const fillAmount = computed(() =>
  props.amount === null || props.amount === undefined
    ? null
    : cashToAmountInput(props.amount, props.decimals),
);
</script>

<template>
  <SkeletonBlock
    v-if="amount === null || (skeleton && amount !== undefined)"
    v-bind="$attrs"
    style="width: 10.5rem; height: 1.75rem"
  />
  <button
    v-else-if="fillAmount !== null"
    v-bind="$attrs"
    type="button"
    class="available-pill text-label-m"
    @click="emit('fill', fillAmount)"
  >
    Available <CashAmount :amount="groupAmountDigits(fillAmount)" />
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
