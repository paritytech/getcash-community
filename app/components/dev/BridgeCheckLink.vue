<script setup lang="ts">
// The way into the bridge check page, bottom-right, clear of whatever the screen ends on. It
// shows only where that page may show: the preview of a pull request and a developer's copy.
import { useRoute } from "vue-router";
import { isPreviewOrLocal } from "../../utils/pr-preview";

const route = useRoute();
const allowed = isPreviewOrLocal({ hostname: location.hostname, protocol: location.protocol });
</script>

<template>
  <NuxtLink
    v-if="allowed && route.path !== '/bridge-check'"
    to="/bridge-check"
    class="fixed bottom-2 right-2 z-50 cursor-pointer rounded-small bg-surface-container px-2 py-1 text-overline text-fg-secondary shadow-1 transition-colors hover:bg-selection-container-hover"
  >
    Bridge check
  </NuxtLink>
</template>
