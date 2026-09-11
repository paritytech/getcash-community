<script setup lang="ts">
// Label/value rows for a quote or receipt. A row flagged `fees` renders its value as a button
// into the fee-breakdown drill-in.
import type { HTMLAttributes } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { cn } from "@/lib/cn";

const props = defineProps<{
  rows: { label: string; value: string; fees?: boolean }[];
  /** Secondary labels, for screens where the values carry the emphasis. */
  muted?: boolean;
  class?: HTMLAttributes["class"];
}>();
const emit = defineEmits<{ fees: [] }>();
</script>

<template>
  <dl :class="cn('flex flex-col gap-4', props.class)">
    <div v-for="row in rows" :key="row.label" class="flex items-baseline justify-between gap-4">
      <dt class="text-paragraph-l" :class="muted ? 'text-fg-secondary' : 'text-fg-primary'">
        {{ row.label }}
      </dt>
      <dd v-if="row.fees">
        <button
          type="button"
          class="flex items-center gap-1 text-heading-m text-fg-primary"
          @click="emit('fees')"
        >
          {{ row.value }}
          <ChevronRight class="size-4 text-fg-secondary" aria-hidden="true" />
        </button>
      </dd>
      <dd v-else class="text-heading-m text-fg-primary">{{ row.value }}</dd>
    </div>
  </dl>
</template>
