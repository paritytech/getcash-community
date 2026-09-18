<script setup lang="ts">
// The destination address: the network and token already chosen as pills, the address typed or
// pasted, checked against the destination's own rule before Next opens. Scanning waits on a host
// camera capability and is not offered.
import { computed, ref } from "vue";
import { ClipboardPaste } from "lucide-vue-next";
import {
  destinationTokenIcon,
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
/** Nothing is judged until the user typed something. */
const touched = ref(false);
const trimmed = computed(() => address.value.trim());
const valid = computed(
  () => trimmed.value !== "" && props.destination.validateAddress(trimmed.value),
);
const addressInvalid = computed(() => touched.value && trimmed.value !== "" && !valid.value);

function onInput(event: Event) {
  address.value = (event.target as HTMLTextAreaElement).value;
  touched.value = true;
}

/** The clipboard's text, when the webview grants it; otherwise the field is left to the keyboard. */
async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      address.value = text.trim();
      touched.value = true;
    }
  } catch (error: unknown) {
    console.warn("[withdraw] clipboard read unavailable:", error);
  }
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
        :value="address"
        rows="3"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="Address"
        class="address-field w-full resize-none bg-transparent text-center text-heading-l text-fg-primary placeholder:text-display-s placeholder:text-fg-tertiary focus:outline-none"
        :aria-invalid="addressInvalid"
        @input="onInput"
      />
    </label>
    <p v-if="addressInvalid" class="mt-2 text-center text-body-s text-fg-error" role="alert">
      This doesn't look like a valid {{ network.label }} address.
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

    <PillButton class="mt-auto mb-6 w-full" :disabled="!valid" @click="emit('next', trimmed)">
      Next
    </PillButton>
  </div>
</template>

<style scoped>
/* Long addresses wrap anywhere; there are no word boundaries to break on. */
.address-field {
  overflow-wrap: anywhere;
}
</style>
