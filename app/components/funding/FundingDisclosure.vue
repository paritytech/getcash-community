<script setup lang="ts">
import { ref, useId } from "vue";
import { ChevronDown } from "lucide-vue-next";

defineProps<{ title: string }>();

const open = ref(false);
const id = useId();
const buttonId = `funding-disclosure-button-${id}`;
const panelId = `funding-disclosure-panel-${id}`;
</script>

<template>
  <section class="funding-disclosure">
    <h2>
      <button
        :id="buttonId"
        type="button"
        class="funding-disclosure-trigger"
        :aria-expanded="open"
        :aria-controls="panelId"
        @click="open = !open"
      >
        <span class="funding-disclosure-heading text-heading-m">
          <span>{{ title }}</span>
          <ChevronDown
            class="funding-disclosure-chevron size-5"
            :class="{ 'is-open': open }"
            aria-hidden="true"
          />
        </span>
        <slot name="summary" />
      </button>
    </h2>
    <div
      v-show="open"
      :id="panelId"
      class="funding-disclosure-panel"
      role="region"
      :aria-labelledby="buttonId"
    >
      <slot />
    </div>
  </section>
</template>

<style scoped>
.funding-disclosure {
  /* Depth is the container surface plus shadow-1; no group border. */
  overflow: hidden;
  border-radius: var(--radius-container);
  background: var(--bg-surface-container);
  box-shadow: var(--shadow-1);
}

.funding-disclosure-trigger {
  display: flex;
  width: 100%;
  min-height: 3rem;
  padding: 0.875rem 1rem;
  flex-direction: column;
  color: var(--fg-primary);
  text-align: left;
  transition: background-color 150ms ease;
}

.funding-disclosure-trigger:hover {
  background: var(--bg-selection-container-hover);
}

.funding-disclosure-trigger:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

.funding-disclosure-heading {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.funding-disclosure-chevron {
  color: var(--fg-secondary);
  transform: rotate(0deg);
  transition: transform 180ms ease;
}

.funding-disclosure-chevron.is-open {
  transform: rotate(180deg);
}

.funding-disclosure-panel {
  border-top: 1px solid var(--stroke-primary);
  padding: 1rem;
}

@media (prefers-reduced-motion: reduce) {
  .funding-disclosure-chevron {
    transition: none;
  }
}
</style>
