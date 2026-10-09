<script setup lang="ts">
// A labelled single-line input with its error line below. Attributes the caller adds (name,
// maxlength, aria-label, listeners) go to the input itself; class and style stay on the wrapper,
// which is what a layout places.
import { computed, useAttrs, useId } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Shown above the field. Without one, the caller names the input with `aria-label`. */
    label?: string;
    type?: "text" | "email" | "tel";
    autocomplete?: string;
    inputmode?: "text" | "email" | "numeric" | "tel";
    placeholder?: string;
    /** What is wrong with the value, shown under the field. */
    error?: string | null;
    disabled?: boolean;
  }>(),
  { type: "text", error: null },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

// A function, not a computed: `useAttrs` is not reactive, but each render reads it afresh.
const attrs = useAttrs();
const inputAttrs = () =>
  Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== "class" && key !== "style"));

const id = useId();
const errorId = computed(() => (props.error ? `${id}-error` : undefined));
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" :class="attrs.class" :style="attrs.style">
    <label v-if="label" :for="id" class="text-label-m text-fg-secondary">{{ label }}</label>
    <!-- The caller's attributes come last so an aria-invalid it passes for a group wins. -->
    <input
      :id="id"
      :value="modelValue"
      :type="type"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="errorId"
      class="h-12 w-full min-w-0 rounded-nested bg-surface-container px-4 text-body-l text-fg-primary placeholder:text-fg-disabled disabled:text-fg-disabled"
      v-bind="inputAttrs()"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <p v-if="error" :id="errorId" class="text-body-s text-fg-error" role="alert">{{ error }}</p>
  </div>
</template>
