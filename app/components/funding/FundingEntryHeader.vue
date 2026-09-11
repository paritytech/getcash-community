<script setup lang="ts">
import { ChevronLeft, History } from "lucide-vue-next";
import SkeletonBlock from "../ui/SkeletonBlock.vue";

withDefaults(
  defineProps<{
    title: string;
    back?: boolean;
    centered?: boolean;
    history?: boolean;
    /** Launch-load placeholder: the title and history control render as inert skeleton shapes. */
    skeleton?: boolean;
  }>(),
  {
    back: false,
    centered: false,
    history: false,
    skeleton: false,
  },
);

const emit = defineEmits<{
  back: [];
  history: [];
}>();
</script>

<template>
  <header
    class="funding-entry-header"
    :class="{
      'funding-entry-header-back': back,
      'funding-entry-header-centered': centered,
    }"
  >
    <button
      v-if="back"
      type="button"
      class="funding-entry-back"
      aria-label="Back"
      @click="emit('back')"
    >
      <ChevronLeft class="size-6" aria-hidden="true" />
    </button>
    <span v-else-if="centered" aria-hidden="true" />
    <SkeletonBlock v-if="skeleton" style="width: 8.125rem; height: 1.5rem" />
    <h1 v-else-if="title" class="text-heading-l">{{ title }}</h1>
    <span v-else aria-hidden="true" />
    <span v-if="skeleton" class="funding-entry-history animate-pulse" aria-hidden="true" />
    <button
      v-else-if="history"
      type="button"
      class="funding-entry-history"
      aria-label="History"
      @click="emit('history')"
    >
      <History class="size-7" aria-hidden="true" />
    </button>
    <span v-else-if="back || centered" aria-hidden="true" />
  </header>
</template>

<style scoped>
.funding-entry-header {
  display: flex;
  min-height: 3.75rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 1.5rem;
}

.funding-entry-header-back {
  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1fr) 2.75rem;
}

.funding-entry-header-centered {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr) 4.5rem;
}

.funding-entry-header-centered h1 {
  text-align: center;
}

.funding-entry-header h1 {
  min-width: 0;
  overflow: hidden;
  color: var(--fg-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-entry-back {
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--fg-primary);
  transition: background-color 120ms ease-out;
}

.funding-entry-back:hover {
  background: var(--bg-selection-container-hover);
}

.funding-entry-history {
  display: flex;
  width: 2.75rem;
  height: 2.75rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--fg-primary);
  transition: background-color 120ms ease-out;
}

.funding-entry-history:hover {
  background: var(--bg-selection-container-hover);
}

@media (max-height: 650px) {
  .funding-entry-header {
    min-height: 3.25rem;
  }
}
</style>
