<script setup lang="ts">
// Full-screen confirmation before a cancel: the deposit address dies with the request, so the
// choice takes the whole screen. Back and "Keep it" return to the deposit untouched; the red
// pill performs the cancel through the route.
import { useSessionStore } from "../../stores/session";

const emit = defineEmits<{ confirm: []; keep: [] }>();
const session = useSessionStore();
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col gap-2 px-2 text-center">
      <h1 class="text-display-s text-fg-primary">Cancel top-up?</h1>
      <p class="text-paragraph-l text-fg-primary">
        The deposit address will stop working. Don't cancel if you've already sent your funds.
      </p>
    </div>
    <div class="mt-auto flex shrink-0 flex-col gap-3 pb-6">
      <button
        type="button"
        class="h-12 rounded-full bg-status-error text-label-l text-fg-static-white transition-colors hover:bg-status-error-hover disabled:opacity-50"
        :disabled="session.cancelling"
        @click="emit('confirm')"
      >
        {{ session.cancelling ? "Cancelling…" : "Cancel" }}
      </button>
      <button
        type="button"
        class="h-12 rounded-full bg-action-primary text-label-l text-fg-primary-inverted transition-colors hover:bg-action-primary-hover disabled:opacity-50"
        :disabled="session.cancelling"
        @click="emit('keep')"
      >
        Keep it
      </button>
    </div>
  </section>
</template>
