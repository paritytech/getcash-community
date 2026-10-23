<script setup lang="ts">
// The design's snack bar: a short word on what just happened, with its icon, in a pill on the
// nested surface. Where it floats and for how long is the caller's.
import { Check, X } from "lucide-vue-next";

defineProps<{
  text: string;
  tone: "success" | "error";
}>();
</script>

<template>
  <span
    class="flex h-10 items-center gap-2.5 rounded-full bg-surface-nested py-2 pr-3 pl-4 text-body-m whitespace-nowrap text-fg-primary"
    role="status"
  >
    <Check v-if="tone === 'success'" class="size-6 text-fg-success" aria-hidden="true" />
    <X v-else class="size-6 text-fg-error" aria-hidden="true" />
    {{ text }}
  </span>
</template>
