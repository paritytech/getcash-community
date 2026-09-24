<script setup lang="ts">
// Full-screen confirmation before a cancel: what it withdraws dies with the request, so the
// choice takes the whole screen. Back and "Keep it" return to the screen behind it untouched; the
// red pill performs the cancel through the route.
import { computed } from "vue";
import { useSessionStore } from "../../stores/session";
import PillButton from "../ui/PillButton.vue";

const props = withDefaults(
  defineProps<{
    /** What the cancel takes away: the crypto deposit address, or the bank transfer's pay page.
     *  Each warns about the payment its own buyer may already have made. */
    kind?: "deposit" | "transfer";
  }>(),
  { kind: "deposit" },
);
const emit = defineEmits<{ confirm: []; keep: [] }>();
const session = useSessionStore();

const body = computed(() =>
  props.kind === "transfer"
    ? "If you've already sent the transfer, don't cancel, as your money will still arrive. Only cancel if you haven't paid yet."
    : "The deposit address will stop working. Don't cancel if you've already sent your funds.",
);
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col gap-2 px-2 text-center">
      <h1 class="text-display-s text-fg-primary">Cancel top-up?</h1>
      <p class="text-paragraph-l text-fg-primary">{{ body }}</p>
    </div>
    <div class="mt-auto flex shrink-0 flex-col gap-3 pb-6">
      <PillButton
        variant="danger"
        :disabled="session.cancelling || !session.cancelReady"
        @click="emit('confirm')"
      >
        {{ session.cancelling ? "Cancelling…" : "Cancel" }}
      </PillButton>
      <PillButton :disabled="session.cancelling" @click="emit('keep')">Keep it</PillButton>
    </div>
  </section>
</template>
