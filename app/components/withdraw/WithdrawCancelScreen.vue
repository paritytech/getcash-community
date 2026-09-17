<script setup lang="ts">
// Full-screen confirmation before a withdrawal's cancel. Only offered while nothing was paid; the
// store takes a last look at the key and the host before the record moves.
defineProps<{ cancelling: boolean }>();
const emit = defineEmits<{ confirm: []; keep: [] }>();
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col gap-2 px-2 text-center">
      <h1 class="text-display-s text-fg-primary">Cancel withdrawal?</h1>
      <p class="text-paragraph-l text-fg-primary">
        Nothing has left your balance yet. If you already approved the payment, it will still go
        through and the withdrawal continues.
      </p>
    </div>
    <div class="mt-auto flex shrink-0 flex-col gap-3 pb-6">
      <button
        type="button"
        class="h-12 rounded-full bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
        :disabled="cancelling"
        @click="emit('confirm')"
      >
        {{ cancelling ? "Cancelling…" : "Cancel" }}
      </button>
      <button
        type="button"
        class="h-12 rounded-full bg-action-primary text-label-l text-fg-primary-inverted transition-colors hover:bg-action-primary-hover disabled:opacity-50"
        :disabled="cancelling"
        @click="emit('keep')"
      >
        Keep it
      </button>
    </div>
  </section>
</template>
