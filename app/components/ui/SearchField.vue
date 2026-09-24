<script setup lang="ts">
// The list filter: a pill input with a magnifier. Empty and unfocused it centres icon and prompt
// together, the way the platform's own search bars do; typing moves them to the leading edge so
// the text has the width. What the text filters is the caller's.
import { computed, ref } from "vue";
import type { HTMLAttributes } from "vue";
import { Search } from "lucide-vue-next";
import { cn } from "@/lib/cn";

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  /** The field's accessible name, when the placeholder is not one. */
  label?: string;
  class?: HTMLAttributes["class"];
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const focused = ref(false);
/** The resting state: the prompt centred, nothing typed. */
const resting = computed(() => !focused.value && props.modelValue === "");
</script>

<template>
  <div :class="cn('relative h-9', props.class)">
    <!-- The resting prompt, centred as one group. Not the input's own placeholder: that cannot
         carry the icon with it. -->
    <div
      v-if="resting"
      class="pointer-events-none absolute inset-0 flex items-center justify-center gap-2"
    >
      <Search class="size-4.5 text-fg-disabled" aria-hidden="true" />
      <span class="text-body-m text-fg-disabled">{{ placeholder }}</span>
    </div>
    <Search
      v-else
      class="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-fg-tertiary"
      aria-hidden="true"
    />
    <!-- `type="search"`, so the platform offers its own clear control. -->
    <input
      type="search"
      :value="modelValue"
      :aria-label="label ?? placeholder"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      class="size-full rounded-full bg-surface-nested pr-4 text-body-m text-fg-primary"
      :class="resting ? 'pl-4' : 'pl-9'"
      @focus="focused = true"
      @blur="focused = false"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>
