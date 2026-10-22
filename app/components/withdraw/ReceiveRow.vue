<script setup lang="ts">
// The "You'll receive" figure under a fee split, with the rate it implies. One line at the type
// step its symbol count earns: a short figure at display size, a long one stepped down.
import { computed } from "vue";
import { figureStep } from "../../utils/figure-size";

const props = defineProps<{
  /** What lands, already formatted with its asset or currency. */
  receive: string;
  /** The rate line under the figure; left out when null. */
  rate: string | null;
}>();

const step = computed(() => figureStep(props.receive));
</script>

<template>
  <div class="mt-2 flex flex-col gap-1">
    <div class="flex items-center justify-between gap-4">
      <span class="shrink-0 text-paragraph-l text-fg-secondary">You'll receive</span>
      <span class="min-w-0 text-right whitespace-nowrap text-fg-primary" :class="step">
        {{ receive }}
      </span>
    </div>
    <div v-if="rate" class="flex items-baseline justify-between gap-4">
      <span class="text-paragraph-l text-fg-secondary">Rate</span>
      <span class="text-paragraph-l text-fg-secondary">{{ rate }}</span>
    </div>
  </div>
</template>
