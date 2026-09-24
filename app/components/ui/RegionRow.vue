<script setup lang="ts">
// The row that names the region a payment is made from, and opens the picker.
//
// Both Meld screens carry one — the card screen names the country, the bank screen the currency it
// charges in — so the row is one component and the caller brings the words.
import { ChevronRight } from "lucide-vue-next";
import FlagCircle from "./FlagCircle.vue";

defineProps<{
  /** What the row is, e.g. "Payment country". */
  label: string;
  /** The committed region, written as the design names it. */
  value: string;
  /** The region the flag is for, as an ISO 3166-1 alpha-2 code. */
  country: string;
}>();
defineEmits<{ open: [] }>();
</script>

<template>
  <div class="flex items-start justify-between gap-4">
    <span class="text-paragraph-l text-fg-primary">{{ label }}</span>
    <button
      type="button"
      class="flex items-center gap-2 text-heading-m text-fg-primary"
      @click="$emit('open')"
    >
      <span class="flex items-center gap-1">
        <FlagCircle :country="country" :size="24" />
        {{ value }}
      </span>
      <ChevronRight class="size-4 text-fg-secondary" aria-hidden="true" />
    </button>
  </div>
</template>
