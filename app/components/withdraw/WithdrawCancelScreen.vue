<script setup lang="ts">
// Full-screen confirmation before a withdrawal's cancel. Only offered while nothing was paid; the
// store takes a last look at the key and the host before the record moves.
import PillButton from "../ui/PillButton.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";

defineProps<{ cancelling: boolean }>();
const emit = defineEmits<{ confirm: []; keep: [] }>();
</script>

<template>
  <ScreenFrame>
    <div class="flex flex-col gap-2 px-2 text-center">
      <h1 class="text-display-s text-fg-primary">Cancel withdrawal?</h1>
      <p class="text-paragraph-l text-fg-primary">
        Nothing has left your balance yet. If you already approved the payment, it will still go
        through and the withdrawal continues.
      </p>
    </div>
    <template #actions>
      <div class="flex flex-col gap-3">
        <PillButton variant="danger" :disabled="cancelling" @click="emit('confirm')">
          {{ cancelling ? "Cancelling…" : "Cancel" }}
        </PillButton>
        <PillButton :disabled="cancelling" @click="emit('keep')">Keep it</PillButton>
      </div>
    </template>
  </ScreenFrame>
</template>
