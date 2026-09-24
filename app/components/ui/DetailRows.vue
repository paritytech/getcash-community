<script setup lang="ts">
// Label/value rows for a quote or receipt. A row flagged `fees` renders its value as a button into
// the fee-breakdown drill-in; a row carrying `copy` renders it as a button that puts that text on
// the clipboard, which lets `value` be an abbreviation of something too long to show in full; a
// row carrying `note` hangs a quiet second line under the value.
import { ref, type HTMLAttributes } from "vue";
import { Check, ChevronRight, Copy } from "lucide-vue-next";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";
import { cn } from "@/lib/cn";

export interface DetailRow {
  label: string;
  value: string;
  /** Renders the value as the entry into the fee breakdown. */
  fees?: boolean;
  /** The full text to copy, when the row is copyable. `value` may be a shortened form of it. */
  copy?: string;
  /** A secondary line under the value (the rate caveat under an arrival estimate). */
  note?: string;
}

const props = defineProps<{
  rows: DetailRow[];
  /** Secondary labels, for screens where the values carry the emphasis. */
  muted?: boolean;
  class?: HTMLAttributes["class"];
}>();
const emit = defineEmits<{ fees: [] }>();

// One flag across the list: only one row is ever copied at a time, and the tick sits on the row
// that was tapped because the others have no copy button to show it on.
const { copied, copy } = useCopyToClipboard();
const justCopied = ref<string | null>(null);
async function copyRow(row: DetailRow) {
  if (row.copy === undefined) return;
  justCopied.value = row.label;
  await copy(row.copy);
}
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
      <dd v-else-if="row.copy !== undefined">
        <button
          type="button"
          class="flex items-center gap-2 text-heading-m text-fg-primary"
          :aria-label="`Copy ${row.label}`"
          @click="copyRow(row)"
        >
          {{ row.value }}
          <Check
            v-if="copied && justCopied === row.label"
            class="size-5 text-fg-success"
            aria-hidden="true"
          />
          <Copy v-else class="size-5 shrink-0 text-fg-secondary" aria-hidden="true" />
        </button>
      </dd>
      <dd v-else-if="row.note" class="flex flex-col items-end text-right">
        <span class="text-heading-m text-fg-primary">{{ row.value }}</span>
        <span class="text-body-s text-fg-secondary">{{ row.note }}</span>
      </dd>
      <dd v-else class="text-heading-m text-fg-primary">{{ row.value }}</dd>
    </div>
  </dl>
</template>
