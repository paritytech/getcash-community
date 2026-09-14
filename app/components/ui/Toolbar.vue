<script setup lang="ts">
// The toolbar: a 44px glass back button, an optional centered title, and a 44px trailing slot. Both
// ends are always reserved.
import { ChevronLeft } from "lucide-vue-next";

defineProps<{ title?: string; back?: boolean }>();
const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <header class="flex h-15 shrink-0 items-center gap-2.5 px-6">
    <div class="flex w-11 shrink-0 items-center">
      <button
        v-if="back"
        type="button"
        class="toolbar-glass flex size-11 items-center justify-center rounded-full"
        aria-label="Back"
        @click="emit('back')"
      >
        <ChevronLeft class="size-7 text-fg-primary" aria-hidden="true" />
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

<style scoped>
/* Approximates the design's glass material with theme tokens: a translucent fg-tinted fill,
 * a specular rim brightest at the top, and a backdrop blur for content sliding beneath. */
.toolbar-glass {
  background: color-mix(in srgb, var(--fg-primary) 6%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--fg-primary) 18%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--fg-primary) 10%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: background-color 150ms;
}

.toolbar-glass:hover {
  background: color-mix(in srgb, var(--fg-primary) 11%, transparent);
}
</style>
