<script setup lang="ts">
// A small "Network / Ethereum" plate showing one thing already chosen.
defineProps<{ label: string; value: string; icon: string }>();
</script>

<template>
  <div class="flex items-center gap-2 rounded-full bg-surface-nested px-3 py-2">
    <span class="size-6 shrink-0 overflow-clip rounded-full">
      <img :src="icon" alt="" class="size-full" />
    </span>
    <span class="flex flex-col">
      <span class="text-label-s text-fg-secondary">{{ label }}</span>
      <span class="text-body-m text-fg-primary">{{ value }}</span>
    </span>
  </div>
</template>
