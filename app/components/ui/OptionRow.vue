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
      class="-mx-3 flex w-full items-center gap-3 rounded-nested px-3 py-1.5 text-left transition-colors enabled:hover:bg-surface-container disabled:opacity-50"
      :disabled="disabled"
      @click="emit('select')"
    >
      <span class="size-12 shrink-0 overflow-clip rounded-container">
        <img :src="icon" alt="" class="size-full" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="text-heading-m text-fg-primary">{{ label }}</span>
        <span v-if="subtitle" class="truncate text-body-m text-fg-secondary">
          {{ subtitle }}
        </span>
      </span>
    </button>
  </li>
</template>
