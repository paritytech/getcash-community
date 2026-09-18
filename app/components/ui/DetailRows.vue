<script setup lang="ts">
// Label/value rows for a quote or receipt. A row flagged `fees` renders its value as a button
// into the fee-breakdown drill-in; one carrying `copy` puts the value on the clipboard; `note`
// hangs a quiet second line under the value.
import type { HTMLAttributes } from "vue";
import { ChevronRight, Copy } from "lucide-vue-next";
import { cn } from "@/lib/cn";

const props = defineProps<{
  rows: {
    label: string;
    value: string;
    /** The value drills into the fee breakdown. */
    fees?: boolean;
    /** What tapping the value copies; the row reads as a copy button when set. */
    copy?: string;
    /** A secondary line under the value (the rate caveat under an arrival estimate). */
    note?: string;
  }[];
  /** Secondary labels, for screens where the values carry the emphasis. */
  muted?: boolean;
  class?: HTMLAttributes["class"];
}>();
const emit = defineEmits<{ fees: []; copy: [text: string] }>();
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
      <dd v-else-if="row.copy">
        <button
          type="button"
          class="flex items-center gap-2 text-heading-m text-fg-primary"
          :aria-label="`Copy ${row.label.toLowerCase()}`"
          @click="emit('copy', row.copy)"
        >
          {{ row.value }}
          <Copy class="size-5 shrink-0 text-fg-secondary" aria-hidden="true" />
        </button>
      </dd>
      <dd v-else class="flex flex-col items-end text-right">
        <span class="text-heading-m text-fg-primary">{{ row.value }}</span>
        <span v-if="row.note" class="text-body-s text-fg-secondary">{{ row.note }}</span>
      </dd>
    </div>
  </dl>
</template>
