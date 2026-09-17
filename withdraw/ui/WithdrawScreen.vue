<script setup lang="ts">
import { useVisualViewportHeight } from "~~/app/composables/useVisualViewportHeight";

useVisualViewportHeight();
</script>

<template>
  <main class="withdraw-screen" aria-labelledby="withdraw-title">
    <section class="withdraw-screen-scroll">
      <div class="withdraw-screen-copy">
        <h1 id="withdraw-title" class="text-display-l text-fg-primary">Withdraw CASH</h1>
        <p class="max-w-[18rem] text-paragraph-l text-fg-secondary">
          Withdrawals are not available yet.
        </p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.withdraw-screen {
  position: fixed;
  top: var(--vvt, 0px);
  right: 0;
  left: 0;
  width: 100%;
  max-width: 24.125rem;
  height: var(--vvh, 100dvh);
  margin: 0 auto;
  overflow: hidden;
  background: var(--bg-surface-main);
  color: var(--fg-primary);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}

.withdraw-screen-scroll {
  display: flex;
  min-height: 100%;
  max-height: 100%;
  overflow-y: auto;
  padding: 2rem 1.5rem;
}

.withdraw-screen-copy {
  display: flex;
  min-height: 100%;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: var(--scale-space-small);
}
</style>
