<script setup lang="ts">
// The destination address: the network and token already chosen as pills, the address typed or
// pasted, checked against the destination's own rule. An address another network would take gets
// the wrong-network error; anything else invalid is just incorrect. Valid turns the disabled Next
// into Continue with the design's wrong-network warning. The design's Scan button is left out:
// the host grants a Camera permission but has no scanner API, so scanning needs an in-page
// getUserMedia capture and QR decoder that are not built yet.
import { computed, ref } from "vue";
import { CircleAlert, ClipboardPaste } from "lucide-vue-next";
import {
  destinationTokenIcon,
  matchesOtherNetwork,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../../withdraw/destinations";
import PillButton from "../ui/PillButton.vue";
import SourcePill from "../ui/SourcePill.vue";

const props = defineProps<{
  network: WithdrawNetwork;
  destination: WithdrawDestination;
  /** The address as last typed, when the user comes back from the summary. */
  initial?: string;
}>();
const emit = defineEmits<{ next: [address: string] }>();

const address = ref(props.initial ?? "");
const field = ref<HTMLTextAreaElement | null>(null);
/** Nothing is judged until something was typed; an address brought in is judged at once. */
const touched = ref(address.value !== "");
const trimmed = computed(() => address.value.trim());
const valid = computed(
  () => trimmed.value !== "" && props.destination.validateAddress(trimmed.value),
);
const error = computed<string | null>(() => {
  if (!touched.value || trimmed.value === "" || valid.value) return null;
  return matchesOtherNetwork(props.network, trimmed.value)
    ? `This is not ${props.network.label} address`
    : "Incorrect address";
});

function onInput(event: Event) {
  address.value = (event.target as HTMLTextAreaElement).value;
  touched.value = true;
}

/** The clipboard's text, when the platform grants it. WebKit answers the tap with its own
 *  "Paste" callout that has to be tapped too; a refusal focuses the field instead, so the
 *  platform's native paste is one gesture away. */
async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      address.value = text.trim();
      touched.value = true;
      return;
    }
  } catch (error: unknown) {
    console.warn("[withdraw] clipboard read unavailable:", error);
  }
  field.value?.focus();
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex justify-center gap-3">
      <SourcePill label="Network" :value="network.label" :icon="network.icon" />
      <SourcePill
        label="Token"
        :value="destination.asset"
        :icon="destinationTokenIcon(destination)"
      />
    </div>

    <label class="mt-10 flex flex-col items-center gap-2">
      <span class="sr-only">Destination address</span>
      <textarea
        ref="field"
        :value="address"
        rows="3"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="Address"
        class="address-field w-full resize-none bg-transparent text-center text-heading-xl text-fg-primary placeholder:text-display-s placeholder:text-fg-tertiary focus:outline-none"
        :aria-invalid="error !== null"
        @input="onInput"
      />
    </label>
    <p
      v-if="error"
      class="mt-2 flex items-center justify-center gap-1 text-body-m text-fg-error"
      role="alert"
    >
      <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
      {{ error }}
    </p>

    <div class="mt-4 flex justify-center">
      <button
        type="button"
        class="flex h-8 items-center gap-2 rounded-full bg-action-tertiary px-4 text-label-l text-fg-primary transition-colors hover:bg-action-tertiary-hover"
        @click="paste"
      >
        <ClipboardPaste class="size-4" aria-hidden="true" />
        Paste
      </button>
    </div>

    <div class="mt-auto mb-6 flex flex-col gap-4">
      <p v-if="valid" class="text-center text-body-s text-fg-secondary">
        Funds sent to the wrong network can't be recovered.
      </p>
      <PillButton class="w-full" :disabled="!valid" @click="emit('next', trimmed)">
        {{ valid ? "Continue" : "Next" }}
      </PillButton>
    </div>
  </div>
</template>

<style scoped>
/* Long addresses wrap anywhere; there are no word boundaries to break on. */
.address-field {
  overflow-wrap: anywhere;
}
</style>
