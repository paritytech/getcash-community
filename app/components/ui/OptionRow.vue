<script setup lang="ts">
// One row in a selection list, drawn as the design's card: icon plate, label, optional subtitle,
// and a trailing chevron that becomes a spinner while this row's pick is being started.
// `skeleton` renders the same card as an empty loading placeholder.
import { ChevronRight } from "lucide-vue-next";

withDefaults(
  defineProps<{
    icon?: string;
    label?: string;
    subtitle?: string;
    /** This row's pick is in flight: the chevron gives way to a spinner. */
    busy?: boolean;
    disabled?: boolean;
    skeleton?: boolean;
  }>(),
  {
    icon: "",
    label: "",
    subtitle: "",
    busy: false,
    disabled: false,
    skeleton: false,
  },
);
const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <li
    v-if="skeleton"
    class="h-20 shrink-0 animate-pulse rounded-container bg-surface-container"
    aria-hidden="true"
  />
  <li v-else>
    <button
      type="button"
      class="flex w-full items-center gap-3 rounded-container bg-surface-container p-4 text-left shadow-1 transition-shadow hover:shadow-2 disabled:opacity-50"
      :disabled="disabled"
      @click="emit('select')"
    >
      <span class="size-12 shrink-0 overflow-clip rounded-full">
        <img :src="icon" alt="" class="size-full" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="text-heading-m text-fg-primary">{{ label }}</span>
        <span v-if="subtitle" class="truncate text-body-s text-fg-secondary">
          {{ subtitle }}
        </span>
      </span>
      <span
        v-if="busy"
        class="size-5 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-secondary border-r-transparent"
        aria-hidden="true"
      />
      <ChevronRight v-else class="size-5 shrink-0 text-fg-secondary" aria-hidden="true" />
    </button>
  </li>
</template>
