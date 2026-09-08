<script setup lang="ts">
// One row in a selection list: icon plate, label, optional subtitle. The whole row is the tap
// target.
defineProps<{ icon: string; label: string; subtitle?: string; disabled?: boolean }>();
const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <li>
    <button
      type="button"
      class="flex w-full items-center gap-3 text-left disabled:cursor-default disabled:opacity-40"
      :disabled="disabled"
      @click="emit('select')"
    >
      <span class="size-12 shrink-0 overflow-clip rounded-2xl">
        <img :src="icon" alt="" class="size-full" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="text-base leading-6 font-semibold text-text-primary">{{ label }}</span>
        <span v-if="subtitle" class="truncate text-sm leading-5 text-text-secondary">
          {{ subtitle }}
        </span>
      </span>
    </button>
  </li>
</template>
