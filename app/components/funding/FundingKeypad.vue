<script setup lang="ts">
// The amount keypad: three columns, the fourth row a decimal point, a zero and a backspace.
import { Delete } from "lucide-vue-next";
import type { FundingKey } from "../../funding/selection";

withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });

const emit = defineEmits<{ key: [key: FundingKey] }>();

const keypad: readonly (readonly FundingKey[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  [".", "0", "delete"],
];
</script>

<template>
  <div class="funding-keypad" aria-label="Amount keypad">
    <template v-for="(row, rowIndex) in keypad" :key="rowIndex">
      <button
        v-for="key in row"
        :key="key"
        type="button"
        class="text-heading-xl"
        :disabled="disabled"
        :aria-label="key === 'delete' ? 'Delete digit' : `Enter ${key}`"
        @click="emit('key', key)"
      >
        <Delete v-if="key === 'delete'" class="size-6" aria-hidden="true" />
        <span v-else>{{ key }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
/* The keypad follows the content; the flexible space lives below it, on the
   Continue button, so the CTA stays anchored to the bottom edge. The
   margin-bottom keeps a minimum gap to the CTA when the screen is tight and
   the auto margin collapses. */
.funding-keypad {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 1.5rem;
  margin-bottom: 1.5rem;
}

.funding-keypad button {
  display: flex;
  height: 3.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--fg-primary);
  transition: background-color 120ms ease-out;
}

.funding-keypad button:hover {
  background: var(--bg-selection-container-hover);
}

/* Disabled (the launch skeleton) keeps the chrome but mutes it; pointer-events parks the hover
   and pressed styling too, which the disabled attribute alone would leave live. */
.funding-keypad button:disabled {
  color: var(--fg-secondary);
  pointer-events: none;
}

/* The pressed ring is an inset shadow so pressing never shifts the glyph. */
.funding-keypad button:active {
  background: var(--bg-surface-main);
  box-shadow: inset 0 0 0 1px var(--stroke-primary);
}

@media (max-height: 650px) {
  .funding-keypad {
    gap: 0.375rem 0.5rem;
    margin-bottom: 0.625rem;
  }

  .funding-keypad button {
    height: 2.75rem;
  }
}
</style>
