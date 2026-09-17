<script setup lang="ts">
// Label/value rows for a quote or receipt. A row flagged `fees` renders its value as a button
// into the fee-breakdown drill-in.
import type { HTMLAttributes } from "vue";
import { Check, ChevronRight, Copy } from "lucide-vue-next";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import { cn } from "@/lib/cn";

const props = defineProps<{
  rows: { label: string; value: string; fees?: boolean; copy?: string }[];
  /** Secondary labels, for screens where the values carry the emphasis. */
  muted?: boolean;
  class?: HTMLAttributes["class"];
}>();
const emit = defineEmits<{ fees: [] }>();

// One flag for the whole list: only a support reference is ever copyable, and no row set has two.
const { copied, copy } = useCopyToClipboard();
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
          class="flex items-center gap-1 text-heading-m text-fg-primary"
          :aria-label="`Copy ${row.label}`"
          @click="copy(row.copy)"
        >
          {{ row.value }}
          <component
            :is="copied ? Check : Copy"
            class="size-4 shrink-0 text-fg-secondary"
            aria-hidden="true"
          />
        </button>
      </dd>
      <dd v-else class="text-heading-m text-fg-primary">{{ row.value }}</dd>
    </div>
  </dl>
</template>
