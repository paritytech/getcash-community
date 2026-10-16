<script setup lang="ts">
// A price that could not be had, taking the whole screen in two steps. The first offers another
// try: the failure is usually passing. A second failure for the same amount stops offering one and
// points at what the buyer can change instead — the amount, or the rail when crypto is one. A new
// amount starts the count over (the caller resets `failures`).
import ErrorState from "./ErrorState.vue";
import PillButton from "./PillButton.vue";

withDefaults(
  defineProps<{
    /** Price failures in a row for this amount; the second stops offering another try. */
    failures: number;
    /** Offer the crypto rail as the way out. Off on the crypto rail itself. */
    crypto?: boolean;
  }>(),
  { crypto: true },
);
const emit = defineEmits<{ retry: []; changeAmount: []; useCrypto: [] }>();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <ErrorState
      v-if="failures < 2"
      class="my-auto"
      title="Couldn't get the rate"
      body="This is usually temporary. Try again in a moment"
    />
    <ErrorState
      v-else
      class="my-auto"
      title="Still not working"
      :body="
        crypto
          ? 'Try a different amount, or send to a crypto wallet instead'
          : 'Try a different amount'
      "
    />
    <PillButton v-if="failures < 2" class="mb-6 w-full" @click="emit('retry')">
      Try again
    </PillButton>
    <div v-else class="mb-6 flex flex-col gap-4">
      <PillButton v-if="crypto" variant="secondary" class="w-full" @click="emit('useCrypto')">
        Use crypto
      </PillButton>
      <PillButton class="w-full" @click="emit('changeAmount')">Change amount</PillButton>
    </div>
  </div>
</template>
