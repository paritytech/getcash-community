<script setup lang="ts">
import { ref, useId } from "vue";

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
        <span class="funding-disclosure-heading">
          <span>{{ title }}</span>
          <span class="funding-disclosure-chevron" :class="{ 'is-open': open }" aria-hidden="true"
            >⌄</span
          >
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
  overflow: hidden;
  border: 1px solid
    color-mix(in srgb, var(--funding-border, var(--color-stroke-secondary)) 28%, transparent);
  border-radius: 1rem;
  background: var(--funding-surface, var(--color-surface-container));
}

.funding-disclosure-trigger {
  display: flex;
  width: 100%;
  min-height: 3rem;
  padding: 0.875rem 1rem;
  flex-direction: column;
  color: var(--funding-text, var(--color-text-primary));
  text-align: left;
}

.funding-disclosure-trigger:focus-visible {
  outline: 2px solid var(--color-progress);
  outline-offset: -2px;
}

.funding-disclosure-heading {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.9375rem;
  line-height: 1.25rem;
  font-weight: 650;
}

.funding-disclosure-chevron {
  color: var(--funding-text-muted, var(--color-text-secondary));
  font-size: 1.25rem;
  line-height: 1;
  transform: rotate(0deg);
  transition: transform 180ms ease;
}

.funding-disclosure-chevron.is-open {
  transform: rotate(180deg);
}

.funding-disclosure-panel {
  border-top: 1px solid
    color-mix(in srgb, var(--funding-border, var(--color-stroke-secondary)) 24%, transparent);
  padding: 1rem;
}

@media (prefers-reduced-motion: reduce) {
  .funding-disclosure-chevron {
    transition: none;
  }
}
</style>
