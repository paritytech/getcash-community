<script setup lang="ts">
// The state director's scene label, in the one place every container draws it: bottom-left, clear
// of whatever the screen ends on. Nothing renders outside a dev or demo build, where no scene is
// ever set.
import { previewLabel } from "../../composables/useStateDirector";
</script>

<template>
  <span
    v-if="previewLabel"
    class="pointer-events-none fixed bottom-2 left-2 rounded-small bg-surface-container px-2 py-1 font-mono text-overline text-fg-secondary shadow-1"
  >
    {{ previewLabel }}
  </span>
</template>
