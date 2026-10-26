<script setup lang="ts">
// A route's shell: the toolbar over a body that fills the visible viewport inside the safe areas,
// so the app never scrolls. `edge` drops the body padding for a provider's own page.
import PreviewSceneLabel from "../dev/PreviewSceneLabel.vue";
import Toolbar from "./Toolbar.vue";

defineProps<{ title?: string; back?: boolean; edge?: boolean }>();
const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-surface-main"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <Toolbar :title="title" :back="back" @back="emit('back')">
      <template #trailing><slot name="trailing" /></template>
    </Toolbar>

    <div class="flex min-h-0 flex-1 flex-col" :class="edge ? '' : 'px-6 pt-6'">
      <slot />
    </div>

    <!-- state-director scene label (dev/demo keys only) -->
    <PreviewSceneLabel />
  </main>
</template>
