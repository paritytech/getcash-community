<script setup lang="ts">
// Development builds only: the host did not give Cash its chains at launch, so the app does not
// open. Turning the TrUAPI runtime off restarts the host app, which runs the check again, so the
// screen only says how to get past it. The reason is shown as is: the people reading it are
// testing the build.
import ErrorState from "./ui/ErrorState.vue";

defineProps<{ reason: string }>();
</script>

<template>
  <main
    class="fixed inset-0 mx-auto flex w-full max-w-md flex-col bg-surface-main px-6"
    style="padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom)"
  >
    <div class="my-auto flex flex-col items-center gap-4">
      <p class="text-body-s text-fg-secondary">Dev mode only</p>
      <ErrorState
        title="Can't reach the host"
        body="GetCash is incompatible with the TrUAPI runtime. Please turn off the TrUAPI runtime in the app's settings, and then try again."
      />
      <p class="text-center text-body-s break-words text-fg-secondary">{{ reason }}</p>
    </div>
  </main>
</template>
