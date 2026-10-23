<script setup lang="ts">
// The host app gave no chain connection, taking the whole screen. Unlike a price failure nothing
// the buyer can pick changes it, so another try is always offered and nothing else is.
import ErrorState from "./ErrorState.vue";
import PillButton from "./PillButton.vue";

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <ErrorState
      class="my-auto"
      title="Can't connect right now"
      body="Cash couldn't reach the network through the app. Try again, or close and reopen the app"
    />
    <PillButton class="mb-6 w-full" @click="emit('retry')">Try again</PillButton>
  </div>
</template>
