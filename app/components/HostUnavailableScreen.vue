<script setup lang="ts">
// Development builds only: the host did not give Cash its chains at launch, so the app does not
// open. The fix is on the host side, so the screen says how to get past it and offers another try.
// The reason is shown as is: the people reading it are testing the build.
import ErrorState from "./ui/ErrorState.vue";
import PillButton from "./ui/PillButton.vue";

defineProps<{ reason: string }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <main
    class="fixed inset-0 mx-auto flex w-full max-w-md flex-col bg-surface-main px-6"
    style="padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom)"
  >
    <div class="my-auto flex flex-col items-center gap-4">
      <ErrorState
        title="Can't reach the host"
        body="Cash couldn't connect to the network through the Polkadot App. Turn off the TrUAPI runtime in the app's settings, then reopen Cash"
      />
      <p class="text-center text-body-s break-words text-fg-secondary">{{ reason }}</p>
    </div>
    <PillButton class="mb-6 w-full" @click="emit('retry')">Try again</PillButton>
  </main>
</template>
