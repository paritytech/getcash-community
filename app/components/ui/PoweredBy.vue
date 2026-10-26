<script setup lang="ts">
// The provider credit at the foot of a route's first screen, 12px under whatever it follows.
defineProps<{ provider: string }>();
</script>

<template>
  <p class="mt-3 shrink-0 text-center text-body-s text-fg-tertiary">Powered by {{ provider }}</p>
</template>
