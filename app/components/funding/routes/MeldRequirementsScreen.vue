<script setup lang="ts">
// What the provider still asks for before a Meld order, shown only when it asks: a code sent to the
// buyer's email or phone, the extra details it needs, the wait while it reviews, or its refusal.
// Emits `ready` once nothing is outstanding. The host route owns the toolbar, and offers its Back
// to `back()` first.
import { computed, reactive, ref, watch } from "vue";
import { CircleX } from "lucide-vue-next";
import type { RequirementsQuery } from "@getsome/meld";
import { asName } from "../../../funding/top-up-projection";
import {
  countdownOf,
  detailsOf,
  fieldLabel,
  useMeldRequirements,
} from "../../../composables/useMeldRequirements";
import PillButton from "../../ui/PillButton.vue";
import TextField from "../../ui/TextField.vue";

const props = defineProps<{
  /** The order the requirements are for. */
  query: RequirementsQuery;
}>();
const emit = defineEmits<{ ready: []; back: [] }>();

const step = useMeldRequirements(props.query);
const {
  stage,
  channel,
  reason,
  missingFields,
  codeSent,
  inputError,
  exhausted,
  resendIn,
  error,
  busy,
} = step;

const provider = computed(() => asName(props.query.provider));

const contact = ref("");
const code = ref("");
const fields = reactive<Record<string, string>>({});

watch(stage, () => {
  contact.value = "";
  code.value = "";
});
watch(codeSent, () => {
  code.value = "";
});
watch(
  step.ready,
  (ready) => {
    if (ready) emit("ready");
  },
  { immediate: true },
);

const verifying = computed(() => channel.value !== null);
const title = computed(() =>
  channel.value === "PHONE" ? "Confirm your phone number" : "Confirm your email",
);
/** Why the provider asks, from the reason it gave. */
const asks = computed(() => {
  if (reason.value === "STALE") return `${provider.value} asks you to confirm it again.`;
  if (reason.value === "VOIP") return `${provider.value} needs a mobile number.`;
  return `${provider.value} asks for this once.`;
});
const sentTo = computed(() => (channel.value === "PHONE" ? "your phone" : "your email"));
const canSend = computed(() => contact.value.trim() !== "" && !busy.value);
const canConfirm = computed(() => code.value.trim() !== "" && !exhausted.value && !busy.value);
const canSubmit = computed(() => detailsOf(missingFields.value, fields) !== null && !busy.value);

function send() {
  if (canSend.value) void step.sendCode(contact.value);
}
function confirm() {
  if (canConfirm.value) void step.confirm(code.value);
}
function resend() {
  code.value = "";
  void step.resend();
}
function retry() {
  void step.retry();
}
function submit() {
  if (canSubmit.value) void step.submitFields(fields);
}

/** Handles the route's Back inside the step: from the code, back to the contact entry. False when
 *  the route should leave instead. */
function back(): boolean {
  if (!codeSent.value) return false;
  step.changeTarget();
  return true;
}

defineExpose({ back });
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <form
      v-if="verifying && !codeSent"
      class="flex min-h-0 flex-1 flex-col"
      novalidate
      @submit.prevent="send"
    >
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
        <h1 class="text-heading-xl text-fg-primary">{{ title }}</h1>
        <p class="mt-2 text-body-m text-fg-secondary">{{ asks }} We'll send you a code.</p>
        <TextField
          v-if="channel === 'PHONE'"
          v-model="contact"
          class="mt-6"
          label="Phone number"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          placeholder="+44 7700 900123"
          :error="inputError"
        />
        <TextField
          v-else
          v-model="contact"
          class="mt-6"
          label="Email"
          type="email"
          inputmode="email"
          autocomplete="email"
          autocapitalize="none"
          spellcheck="false"
          :error="inputError"
        />
      </div>
      <p v-if="error" class="mb-3 text-center text-body-s text-fg-error" role="alert">
        {{ error }}
      </p>
      <PillButton type="submit" class="mt-auto mb-6 w-full" :disabled="!canSend">
        {{ busy ? "Sending…" : "Send code" }}
      </PillButton>
    </form>

    <form
      v-else-if="verifying"
      class="flex min-h-0 flex-1 flex-col"
      novalidate
      @submit.prevent="confirm"
    >
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
        <h1 class="text-heading-xl text-fg-primary">{{ title }}</h1>
        <p class="mt-2 text-body-m text-fg-secondary">
          {{ asks }} Enter the code we sent to {{ sentTo }}.
        </p>
        <TextField
          v-model="code"
          class="mt-6 [&_input]:text-center [&_input]:tracking-[0.3em]"
          aria-label="Code"
          inputmode="numeric"
          autocomplete="one-time-code"
          :error="inputError"
        />
        <p v-if="resendIn > 0" class="mt-4 text-center text-body-s text-fg-secondary">
          You can ask for a new code in {{ countdownOf(resendIn) }}
        </p>
        <p v-else class="mt-4 text-center">
          <button
            type="button"
            class="text-body-s text-fg-primary underline"
            :disabled="busy"
            @click="resend"
          >
            Send a new code
          </button>
        </p>
      </div>
      <p v-if="error" class="mb-3 text-center text-body-s text-fg-error" role="alert">
        {{ error }}
      </p>
      <PillButton type="submit" class="mt-auto mb-6 w-full" :disabled="!canConfirm">
        {{ busy ? "Checking…" : "Continue" }}
      </PillButton>
    </form>

    <form
      v-else-if="stage === 'details'"
      class="flex min-h-0 flex-1 flex-col"
      novalidate
      @submit.prevent="submit"
    >
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
        <h1 class="text-heading-xl text-fg-primary">A few more details</h1>
        <p class="mt-2 text-body-m text-fg-secondary">
          {{ provider }} needs these before it can take your payment.
        </p>
        <div class="mt-6 flex flex-col gap-4">
          <TextField
            v-for="name in missingFields"
            :key="name"
            :model-value="fields[name] ?? ''"
            :label="fieldLabel(name)"
            @update:model-value="fields[name] = $event"
          />
        </div>
      </div>
      <p v-if="error" class="mb-3 text-center text-body-s text-fg-error" role="alert">
        {{ error }}
      </p>
      <PillButton type="submit" class="mt-auto mb-6 w-full" :disabled="!canSubmit">
        {{ busy ? "Sending…" : "Continue" }}
      </PillButton>
    </form>

    <template v-else-if="stage === 'pending'">
      <div
        class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
      >
        <span
          class="mb-2 size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-label-l font-semibold text-fg-primary">Waiting for {{ provider }}</p>
        <p class="max-w-[260px] text-body-m text-fg-secondary">
          This usually takes a few minutes. We continue when {{ provider }} is ready.
        </p>
      </div>
      <PillButton variant="secondary" class="mb-6 w-full" @click="emit('back')">
        Go back
      </PillButton>
    </template>

    <template v-else-if="stage === 'blocked'">
      <div
        class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
      >
        <CircleX class="size-8 text-fg-error" aria-hidden="true" />
        <p class="text-label-l font-semibold text-fg-primary">
          {{ provider }} can't take this payment
        </p>
        <p class="max-w-[260px] text-body-m text-fg-secondary">
          Nothing was charged. You can go back and pay another way.
        </p>
      </div>
      <PillButton variant="secondary" class="mb-6 w-full" @click="emit('back')">
        Go back
      </PillButton>
    </template>

    <template v-else-if="stage === 'error' || stage === 'unknown'">
      <div class="flex min-h-0 w-full flex-1 flex-col items-center justify-center text-center">
        <p class="max-w-[260px] text-body-m text-fg-secondary" role="alert">
          {{
            stage === "unknown"
              ? `We couldn't check what ${provider} needs. Please try again.`
              : (error ?? "Couldn't reach the payment service. Please try again.")
          }}
        </p>
      </div>
      <PillButton variant="secondary" class="mb-6 w-full" @click="retry">Retry</PillButton>
    </template>

    <div v-else-if="stage === 'loading'" class="flex justify-center pt-16">
      <span
        class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
      />
    </div>
  </div>
</template>
