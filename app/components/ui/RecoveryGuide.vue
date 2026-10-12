<script setup lang="ts">
// The numbered way to move funds into a wallet the buyer controls: where they are, the key to
// import, and what to do with it. The key is read on tap, never on load, and can be masked again
// after a look. What the funds are and why they are here is the caller's, in the status slot.
import { computed, ref, watch } from "vue";
import { Check, Copy, Eye, EyeClosed } from "lucide-vue-next";
import { useCopyToClipboard } from "../../composables/useCopyToClipboard";
import CopiedPill from "./CopiedPill.vue";
import PillButton from "./PillButton.vue";

export interface RecoveryStep {
  text: string;
  /** The card drawn under the step, if any. */
  card: "address" | "key" | null;
}

const props = withDefaults(
  defineProps<{
    title: string;
    steps: RecoveryStep[];
    /** Where the funds are; null while it is being worked out, or when it cannot be. */
    address: string | null;
    addressLabel: string;
    secretLabel: string;
    /** Reads the key on the first tap of the eye; null when it cannot be reached. */
    reveal: () => string | null | Promise<string | null>;
    /** The address or the key can be reached at all. */
    material: boolean;
    /** Still working out whether they can, so the unavailable line waits. */
    loading?: boolean;
    /** Show the key without a tap, for the preview deck. */
    autoReveal?: boolean;
  }>(),
  { loading: false, autoReveal: false },
);
const emit = defineEmits<{ back: [] }>();

const secret = ref<string | null>(null);
const masked = ref(true);

async function toggleKey() {
  if (!masked.value) {
    masked.value = true;
    return;
  }
  if (secret.value === null) secret.value = await props.reveal();
  if (secret.value !== null) masked.value = false;
}

// A changed address means another request took the screen: the held key is stale.
watch(
  () => props.address,
  (address, previous) => {
    if (previous !== undefined && address !== previous) {
      secret.value = null;
      masked.value = true;
    }
  },
);
watch(
  () => [props.autoReveal, props.address] as const,
  ([want]) => {
    if (want && masked.value) void toggleKey();
  },
  { immediate: true },
);

/** Masked, the card shows stand-in dots: the secret is not even read until the eye is tapped. */
const keyText = computed(() =>
  secret.value !== null && !masked.value ? secret.value : "•".repeat(64),
);

const { copied: addressCopied, copy: copyAddress } = useCopyToClipboard();
const { copied: keyCopied, copy: copyKey } = useCopyToClipboard();
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

        <!-- The whole row copies the address; the icon confirms. -->
        <button
          v-if="step.card === 'address' && address"
          type="button"
          class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4 text-left"
          @click="copyAddress(address)"
        >
          <span class="min-w-0">
            <span class="block text-body-s text-fg-secondary">{{ addressLabel }}</span>
            <span class="mt-1 block break-all text-paragraph-l text-fg-primary">
              {{ address }}
            </span>
          </span>
          <Check v-if="addressCopied" class="size-6 shrink-0 text-fg-success" aria-hidden="true" />
          <Copy v-else class="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
        </button>

        <div v-else-if="step.card === 'key' && material" class="flex flex-col gap-3">
          <div
            class="flex items-center justify-between gap-4 rounded-container bg-surface-container py-3 pr-6 pl-4"
          >
            <div class="min-w-0 flex-1">
              <p class="text-body-s text-fg-secondary">{{ secretLabel }}</p>
              <div class="relative mt-1">
                <!-- The one text worth selecting by hand as well as copying. -->
                <p
                  class="break-all text-paragraph-l text-fg-primary select-text"
                  :aria-hidden="masked"
                >
                  {{ keyText }}
                </p>
                <span
                  v-if="masked"
                  class="key-mask absolute -inset-1 rounded-nested"
                  aria-hidden="true"
                />
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-3">
              <button
                v-if="!masked && secret !== null"
                type="button"
                class="-m-2 p-2"
                aria-label="Copy the key"
                @click="copyKey(secret)"
              >
                <Check v-if="keyCopied" class="size-6 text-fg-success" aria-hidden="true" />
                <Copy v-else class="size-6 text-fg-secondary" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="-m-2 p-2"
                :aria-label="masked ? 'Show the key' : 'Hide the key'"
                :aria-pressed="!masked"
                @click="toggleKey"
              >
                <EyeClosed v-if="!masked" class="size-6 text-fg-secondary" aria-hidden="true" />
                <Eye v-else class="size-6 text-fg-secondary" aria-hidden="true" />
              </button>
            </div>
          </div>
          <p class="text-center text-body-s text-fg-error">
            Anyone with this key controls the funds.
          </p>
        </div>
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

<style scoped>
/* The mask binds the black-alpha primitive: no semantic token covers a blurring scrim
 * (reported gap, like the journey hero's red). */
.key-mask {
  background: var(--palette-black-alpha-24);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
</style>
