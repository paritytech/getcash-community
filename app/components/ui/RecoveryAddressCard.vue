<script setup lang="ts">
// A recovery guide's address card: the whole row copies, the icon confirms.
import { Check, Copy } from "lucide-vue-next";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";

defineProps<{ label: string; address: string }>();
const { copied, copy } = useCopyToClipboard();
</script>

<template>
  <button
    type="button"
    class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4 text-left"
    @click="copy(address)"
  >
    <span class="min-w-0">
      <span class="block text-body-s text-fg-secondary">{{ label }}</span>
      <span class="mt-1 block break-all text-paragraph-l text-fg-primary">
        {{ address }}
      </span>
    </span>
    <Check v-if="copied" class="size-6 shrink-0 text-fg-success" aria-hidden="true" />
    <Copy v-else class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
  </button>
</template>
