<script setup lang="ts">
// The toolbar: a 44px glass back button, an optional centered title, and a 44px trailing slot. Both
// ends are always reserved.
import { ChevronLeft } from "lucide-vue-next";

defineProps<{ title?: string; back?: boolean }>();
const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <header class="flex h-15 shrink-0 items-center gap-2.5 px-4">
    <div class="flex w-11 shrink-0 items-center">
      <button
        v-if="back"
        type="button"
        class="flex size-11 items-center justify-center rounded-full bg-action-secondary transition-colors hover:bg-action-secondary-hover"
        aria-label="Back"
        @click="emit('back')"
      >
        <ChevronLeft class="size-6 text-fg-primary" aria-hidden="true" />
      </button>
    </div>
    <p v-if="title" class="min-w-0 flex-1 truncate text-center text-heading-l text-fg-primary">
      {{ title }}
    </p>
    <div v-else class="flex-1" />
    <div class="flex min-w-11 shrink-0 items-center justify-end">
      <slot name="trailing" />
    </div>
  </header>
</template>
