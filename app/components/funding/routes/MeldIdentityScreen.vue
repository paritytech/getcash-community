<script setup lang="ts">
// The one-time identity form: name, email, date of birth and home address for the payment
// country. A field is judged once the buyer leaves it; Continue opens when every field is right.
import { computed, reactive, ref } from "vue";
import type { CustomerRegistration } from "@getsome/meld";
import { namedCountry } from "~~/lib/supported";
import {
  identityErrors,
  registrationOf,
  type IdentityField,
  type IdentityForm,
} from "../../../composables/useMeldIdentityStep";
import { useSessionStore } from "../../../stores/session";
import FlagCircle from "../../ui/FlagCircle.vue";
import PillButton from "../../ui/PillButton.vue";
import TextField from "../../ui/TextField.vue";

const props = defineProps<{
  /** The payment country, which is where the buyer lives. */
  country: string;
  busy?: boolean;
  /** Why the last registration was refused. */
  error?: string | null;
}>();
const emit = defineEmits<{ submit: [details: CustomerRegistration] }>();

const session = useSessionStore();
const countryLabel = computed(() => namedCountry(props.country, session.supportedCountries));

const form = reactive<IdentityForm>({
  firstName: "",
  lastName: "",
  email: "",
  birthDay: "",
  birthMonth: "",
  birthYear: "",
  lineOne: "",
  city: "",
  postalCode: "",
});
const left = ref(new Set<IdentityField>());
const errors = computed(() => identityErrors(form));
const registration = computed(() => registrationOf(form, props.country));

function leave(field: IdentityField) {
  left.value = new Set(left.value).add(field);
}
function errorOf(field: IdentityField): string | null {
  return left.value.has(field) ? (errors.value[field] ?? null) : null;
}
/** The date is judged once the year, its last part, has been left. */
const dateError = computed(() => errorOf("dateOfBirth"));

function submit() {
  if (registration.value && !props.busy) emit("submit", registration.value);
}
</script>

<template>
  <form class="flex min-h-0 flex-1 flex-col" novalidate @submit.prevent="submit">
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
      <h1 class="text-heading-xl text-fg-primary">Verify your identity</h1>
      <p class="mt-2 text-body-m text-fg-secondary">
        You do this one time. Meld and the payment provider use these details to check who you are.
      </p>

      <div class="mt-6 flex flex-col gap-4">
        <div class="grid grid-cols-2 gap-3">
          <TextField
            v-model="form.firstName"
            label="First name"
            autocomplete="given-name"
            :error="errorOf('firstName')"
            @blur="leave('firstName')"
          />
          <TextField
            v-model="form.lastName"
            label="Last name"
            autocomplete="family-name"
            :error="errorOf('lastName')"
            @blur="leave('lastName')"
          />
        </div>
        <TextField
          v-model="form.email"
          label="Email"
          type="email"
          inputmode="email"
          autocomplete="email"
          autocapitalize="none"
          spellcheck="false"
          :error="errorOf('email')"
          @blur="leave('email')"
        />
        <fieldset>
          <legend class="mb-2 text-label-m text-fg-secondary">Date of birth</legend>
          <div class="grid grid-cols-[1fr_1fr_1.5fr] gap-3">
            <TextField
              v-model="form.birthDay"
              inputmode="numeric"
              autocomplete="bday-day"
              placeholder="DD"
              maxlength="2"
              aria-label="Day of birth"
              :aria-invalid="dateError ? true : undefined"
              :aria-describedby="dateError ? 'identity-dob-error' : undefined"
            />
            <TextField
              v-model="form.birthMonth"
              inputmode="numeric"
              autocomplete="bday-month"
              placeholder="MM"
              maxlength="2"
              aria-label="Month of birth"
              :aria-invalid="dateError ? true : undefined"
              :aria-describedby="dateError ? 'identity-dob-error' : undefined"
            />
            <TextField
              v-model="form.birthYear"
              inputmode="numeric"
              autocomplete="bday-year"
              placeholder="YYYY"
              maxlength="4"
              aria-label="Year of birth"
              :aria-invalid="dateError ? true : undefined"
              :aria-describedby="dateError ? 'identity-dob-error' : undefined"
              @blur="leave('dateOfBirth')"
            />
          </div>
          <p
            v-if="dateError"
            id="identity-dob-error"
            class="mt-2 text-body-s text-fg-error"
            role="alert"
          >
            {{ dateError }}
          </p>
        </fieldset>
        <TextField
          v-model="form.lineOne"
          label="Home address"
          autocomplete="address-line1"
          :error="errorOf('lineOne')"
          @blur="leave('lineOne')"
        />
        <div class="grid grid-cols-2 gap-3">
          <TextField
            v-model="form.city"
            label="City"
            autocomplete="address-level2"
            :error="errorOf('city')"
            @blur="leave('city')"
          />
          <TextField
            v-model="form.postalCode"
            label="Postcode"
            autocomplete="postal-code"
            :error="errorOf('postalCode')"
            @blur="leave('postalCode')"
          />
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-label-m text-fg-secondary">Country</span>
          <div class="flex h-12 items-center gap-3 rounded-nested bg-surface-container px-4">
            <FlagCircle :country="country" :size="24" />
            <span class="text-body-l text-fg-primary">{{ countryLabel }}</span>
          </div>
        </div>
      </div>
    </div>

    <p v-if="error" class="mb-3 text-center text-body-s text-fg-error" role="alert">
      {{ error }}
    </p>
    <PillButton type="submit" class="mt-auto mb-6 w-full" :disabled="!registration || busy">
      {{ busy ? "Sending…" : "Continue" }}
    </PillButton>
  </form>
</template>
