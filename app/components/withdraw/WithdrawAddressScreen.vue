<script setup lang="ts">
// The destination address: the network and token already chosen as pills, the address typed,
// pasted or scanned from a QR code, checked against the destination's own rule. An address another
// network would take gets the wrong-network error; anything else invalid is just incorrect. A
// scanned code made for another network or token says so. Valid turns the disabled Next into
// Continue with the design's wrong-network warning.
import { computed, ref } from "vue";
import { CircleAlert, Clipboard, Scan } from "lucide-vue-next";
import {
  destinationTokenIcon,
  matchesOtherNetwork,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../../withdraw/destinations";
import { readScannedCode, scanMismatch } from "../../withdraw/scan";
import PillButton from "../ui/PillButton.vue";
import ScreenFrame from "../ui/ScreenFrame.vue";
import SourcePill from "../ui/SourcePill.vue";
import QrScanner from "./QrScanner.vue";
import { devLog } from "~~/lib/log";

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
/** A scanned code made for another chain or token than the destination, with the address it
 *  gave: that address stays refused while the field holds it, in any case. */
const scannedMismatch = ref<{ address: string; problem: "network" | "token" } | null>(null);
const scanProblem = computed(() =>
  scannedMismatch.value?.address.toLowerCase() === trimmed.value.toLowerCase()
    ? scannedMismatch.value.problem
    : null,
);
const addressOk = computed(
  () => trimmed.value !== "" && props.destination.validateAddress(trimmed.value),
);
const valid = computed(() => addressOk.value && scanProblem.value === null);
const wrongNetwork = computed(() => `This is not ${props.network.label} address`);
const error = computed<string | null>(() => {
  if (!touched.value || trimmed.value === "") return null;
  if (!addressOk.value) {
    return matchesOtherNetwork(props.network, trimmed.value)
      ? wrongNetwork.value
      : "Incorrect address";
  }
  if (scanProblem.value === "network") return `This QR code is not for ${props.network.label}`;
  if (scanProblem.value === "token") return `This QR code is not for ${props.destination.asset}`;
  return null;
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
    devLog("withdraw", "clipboard read unavailable", error, "warn");
  }
  field.value?.focus();
}

const scanning = ref(false);

/** A code read by the camera fills the field as a paste does, the address taken out of a
 *  payment URI when the code is one. A code naming another chain or token is shown but not
 *  taken. */
function scanned(text: string) {
  scanning.value = false;
  const code = readScannedCode(text);
  address.value = code.address;
  touched.value = true;
  const problem = scanMismatch(code, props.network.chain, props.destination.asset);
  scannedMismatch.value = problem === null ? null : { address: code.address.trim(), problem };
}
</script>

<template>
  <ScreenFrame>
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

    <div class="mt-4 flex justify-center gap-2">
      <button
        type="button"
        class="flex h-8 w-[105px] items-center justify-center gap-2 rounded-full bg-action-tertiary px-4 text-label-l text-fg-primary transition-colors hover:bg-action-tertiary-hover"
        @click="paste"
      >
        <Clipboard class="size-4" aria-hidden="true" />
        Paste
      </button>
      <button
        type="button"
        class="flex h-8 w-[105px] items-center justify-center gap-2 rounded-full bg-action-tertiary px-4 text-label-l text-fg-primary transition-colors hover:bg-action-tertiary-hover"
        @click="scanning = true"
      >
        <Scan class="size-4" aria-hidden="true" />
        Scan
      </button>
    </div>
    <QrScanner v-if="scanning" @scanned="scanned" @close="scanning = false" />

    <template #actions>
      <div class="flex flex-col gap-4">
        <p v-if="valid" class="text-center text-body-s text-fg-secondary">
          Funds sent to the wrong network can't be recovered.
        </p>
        <PillButton class="w-full" :disabled="!valid" @click="emit('next', trimmed)">
          {{ valid ? "Continue" : "Next" }}
        </PillButton>
      </div>
    </template>
  </ScreenFrame>
</template>

<style scoped>
/* Long addresses wrap anywhere; there are no word boundaries to break on. */
.address-field {
  overflow-wrap: anywhere;
}
</style>
