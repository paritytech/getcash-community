<script setup lang="ts">
// A small "Network / Ethereum" plate showing one thing already chosen.
defineProps<{ label: string; value: string; icon: string }>();
</script>

<template>
  <div class="flex items-center gap-2 rounded-3xl bg-surface-nested px-3 py-2">
    <span class="size-6 shrink-0 overflow-clip rounded-full">
      <img :src="icon" alt="" class="size-full" />
    </span>
    <span class="flex flex-col">
      <span class="text-xs leading-4 font-medium text-text-secondary">{{ label }}</span>
      <span class="text-sm leading-[18px] text-text-primary">{{ value }}</span>
    </span>
  </div>
</template>
