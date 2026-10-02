<script setup lang="ts">
// A recovery guide's masked-key card: stand-in dots behind a blur until the eye is tapped, copy
// only while revealed, the control warning underneath. Fully controlled — the owner runs the
// reveal on `toggle`, since where the secret comes from differs per guide.
import { computed } from "vue";
import { Check, Copy, Eye, EyeClosed } from "lucide-vue-next";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";

const props = withDefaults(
  defineProps<{
    label: string;
    /** The secret once the owner revealed it; null while never revealed. */
    secret: string | null;
    masked: boolean;
    warning?: string;
  }>(),
  { warning: "Anyone with this key controls the funds." },
);
const emit = defineEmits<{ toggle: [] }>();

/** Masked, the card shows stand-in dots: the secret is not even read until the eye is tapped. */
const keyText = computed(() =>
  props.secret !== null && !props.masked ? props.secret : "•".repeat(64),
);

const { copied, copy } = useCopyToClipboard();
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4"
    >
      <div class="min-w-0 flex-1">
        <p class="text-body-s text-fg-secondary">{{ label }}</p>
        <div class="relative mt-1">
          <p class="break-all text-paragraph-l text-fg-primary" :aria-hidden="masked">
            {{ keyText }}
          </p>
          <span
            v-if="masked"
            class="key-mask absolute -inset-1 rounded-nested"
            aria-hidden="true"
          />
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <button
          v-if="!masked && secret !== null"
          type="button"
          class="-m-2 p-2"
          aria-label="Copy the key"
          @click="copy(secret)"
        >
          <Check v-if="copied" class="size-6 text-fg-success" aria-hidden="true" />
          <Copy v-else class="size-6 text-fg-secondary" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="-m-2 p-2"
          :aria-label="masked ? 'Show the key' : 'Hide the key'"
          :aria-pressed="!masked"
          @click="emit('toggle')"
        >
          <EyeClosed v-if="!masked" class="size-6 text-fg-secondary" aria-hidden="true" />
          <Eye v-else class="size-6 text-fg-secondary" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p class="text-center text-body-s text-fg-error">{{ warning }}</p>
  </div>
</template>

<style scoped>
/* The mask binds the black-alpha primitive: no semantic token covers a blurring scrim
 * (reported gap, like the journey hero's red). */
.key-mask {
  background: var(--palette-black-alpha-24);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
</style>
