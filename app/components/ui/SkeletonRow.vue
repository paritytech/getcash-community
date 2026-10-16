<script setup lang="ts">
// One loading row shaped like a label/value pair, for screens that resolve row by row.
import SkeletonBlock from "./SkeletonBlock.vue";

withDefaults(defineProps<{ labelWidth?: string; valueWidth?: string }>(), {
  labelWidth: "w-2/5",
  valueWidth: "w-1/5",
});
</script>

<template>
  <div class="flex h-6 items-center justify-between">
    <SkeletonBlock class="h-4" :class="labelWidth" />
    <SkeletonBlock class="h-4" :class="valueWidth" />
  </div>
</template>
