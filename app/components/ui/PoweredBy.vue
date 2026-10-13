<script setup lang="ts">
// The provider credit at the foot of a route's first screen. Placement is the screen's.
defineProps<{ provider: string }>();
</script>

<template>
  <p class="shrink-0 text-center text-body-s text-fg-tertiary">Powered by {{ provider }}</p>
</template>
