<script setup lang="ts">
// A centred failure notice: the red alert mark, a headline and a line saying what to do.
defineProps<{ title: string; body: string }>();
</script>

<template>
  <div class="flex flex-col items-center gap-4 text-center" role="alert">
    <img src="/icons/alert-error.svg" width="48" height="48" alt="" />
    <div class="flex flex-col gap-2">
      <h1 class="text-display-l text-fg-primary">{{ title }}</h1>
      <p class="text-body-m text-fg-primary">{{ body }}</p>
    </div>
  </div>
</template>
