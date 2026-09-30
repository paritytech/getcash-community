<script setup lang="ts">
// The numbered way to move funds into a wallet the buyer controls: where they are, the key to
// import, and what to do with it. What the funds are and why they are here is the caller's, in the
// status slot. Controlled: the caller holds the reveal state (`useRecoveryKey`), because where the
// secret comes from — and what it must agree with — differs per guide.
import CopiedPill from "./CopiedPill.vue";
import PillButton from "./PillButton.vue";
import RecoveryAddressCard from "./RecoveryAddressCard.vue";
import RecoveryKeyCard from "./RecoveryKeyCard.vue";

export interface RecoveryStep {
  text: string;
  /** The card drawn under the step, if any. */
  card: "address" | "key" | null;
}

withDefaults(
  defineProps<{
    title: string;
    steps: readonly RecoveryStep[];
    /** Where the funds are; null while it is being worked out, or when it cannot be. */
    address: string | null;
    addressLabel: string;
    secretLabel: string;
    /** The key once the caller revealed it; null while never revealed. */
    secret: string | null;
    masked: boolean;
    /** The address or the key can be reached at all. */
    material: boolean;
    /** Still working out whether they can, so the unavailable line waits. */
    loading?: boolean;
  }>(),
  { loading: false },
);
const emit = defineEmits<{ toggle: []; back: [] }>();
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6" :aria-label="title">
    <div class="flex shrink-0 flex-col gap-2 text-center">
      <h1 class="text-display-s text-fg-primary">{{ title }}</h1>
      <p class="text-paragraph-l text-fg-primary"><slot name="status" /></p>
    </div>

    <ol class="mt-8 flex shrink-0 flex-col gap-6">
      <li v-for="(step, index) in steps" :key="index" class="flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fg-primary text-heading-l text-fg-primary-inverted"
            aria-hidden="true"
          >
            {{ index + 1 }}
          </span>
          <p class="text-body-m text-fg-primary">{{ step.text }}</p>
        </div>

        <RecoveryAddressCard
          v-if="step.card === 'address' && address"
          :label="addressLabel"
          :address="address"
        />

        <RecoveryKeyCard
          v-else-if="step.card === 'key' && material"
          :label="secretLabel"
          :secret="secret"
          :masked="masked"
          @toggle="emit('toggle')"
        />
      </li>
    </ol>

    <!-- Nothing to hand over. Said once, under the steps, rather than leaving each of them to
         trail off into a card that never appears. -->
    <p v-if="!material && !loading" class="mt-6 shrink-0 text-center text-body-m text-fg-error">
      Your recovery address and key can't be loaded on this device. Open this top-up in the Polkadot
      App to reach them.
    </p>

    <div class="mt-auto shrink-0 pt-8">
      <CopiedPill />
      <PillButton variant="tertiary" class="w-full" @click="emit('back')">Back</PillButton>
    </div>
  </section>
</template>
