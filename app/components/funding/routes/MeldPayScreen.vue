<script setup lang="ts">
// The Meld package's first screen: region, the quote it produced, and Continue into the provider
// widget. The method is fixed by the route; the region is the buyer's only choice.
import { computed, onMounted, ref } from "vue";
import { useSessionStore } from "../../../stores/session";
import type { FundingRoute } from "../../../funding/selection";
import CountryCombobox from "../../ui/CountryCombobox.vue";

const session = useSessionStore();
// Asks the shell to swap to the crypto package when this region routes neither card nor bank.
const emit = defineEmits<{ switchRoute: [route: FundingRoute] }>();

const via = computed(() => (session.method === "bank" ? "Bank transfer" : "Card"));

// The adapter's buyer-facing refusal message, shown under the quote and blocking Continue.
const startError = ref<string | null>(null);

// Fallback region list, used when the adapter's live catalog is unreachable. Remove once
// geolocation lands.
const FALLBACK_COUNTRIES = [
  { country: "US", name: "United States" },
  { country: "CA", name: "Canada" },
  { country: "GB", name: "United Kingdom" },
  { country: "DE", name: "Germany" },
  { country: "AU", name: "Australia" },
  { country: "BR", name: "Brazil" },
] as const;

/** The region shown before the buyer picks one; matches the quoter's own default region. */
const DEFAULT_COUNTRY = "US";

// The picker's rows: every country the live catalog lists, else the static fallback.
const countryOptions = computed(() => {
  const live = session.supportedCountries;
  return live && live.length > 0
    ? live
    : FALLBACK_COUNTRIES.map((c) => ({ country: c.country, name: c.name }));
});
// The shown country matches the quoted region.
const selectedCountry = computed(() => session.meldCountry ?? DEFAULT_COUNTRY);

// Adopts the default region and quotes when none is chosen, then loads the full catalog. A catalog
// failure leaves the fallback list in place.
onMounted(() => {
  if (session.meldCountry === null) {
    session.setMeldCountry(DEFAULT_COUNTRY);
    requote();
  }
  void session.loadSupportedCountries();
});
// Re-quoting clears a previous refusal.
function requote() {
  startError.value = null;
  void session.fetchMeldQuote();
}
// Fired only on a committed country, never on the picker's filter text.
function pickCountry(country: string) {
  session.setMeldCountry(country);
  requote();
}

// When the chosen method is not routed for this region, offers the other method if the corridor has
// it, otherwise the crypto route.
const otherMethod = computed<"card" | "bank">(() => (session.method === "bank" ? "card" : "bank"));
const otherMethodAvailable = computed(() =>
  (session.meldCorridor?.methods ?? []).some((m) => m.category === otherMethod.value),
);
const methodLabel = (m: "card" | "bank") => (m === "bank" ? "Bank transfer" : "Card");
function useOtherMethod() {
  session.setMethod(otherMethod.value);
  requote();
}
function useCryptoRoute() {
  emit("switchRoute", "crypto");
}

const quoteRows = computed(() => {
  const q = session.quoted;
  if (!q) return [];
  return [
    { label: "You pay", value: `${q.send} ${q.symbol}` },
    { label: "You receive", value: `${session.amountHuman} CASH` },
    { label: "Via", value: via.value },
    { label: "Est. time", value: "~a few min" },
  ];
});

const starting = ref(false);
const canContinue = computed(
  () =>
    !session.loading &&
    !session.quoteError &&
    !session.meldMethodUnavailable &&
    !!session.quoted &&
    !starting.value &&
    // A refusal blocks Continue until a fresh quote clears it.
    startError.value === null,
);
async function next() {
  if (!canContinue.value) return;
  starting.value = true;
  startError.value = null;
  try {
    await session.start();
  } catch (e) {
    console.warn("[meld] could not start the payment:", e);
    startError.value =
      e instanceof Error ? e.message : "Could not start the payment. Please try again.";
    starting.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <h1 class="text-headline font-semibold">
      Pay with {{ session.method === "bank" ? "bank transfer" : "card" }}
    </h1>

    <!-- Temporary region picker, removed once geolocation lands. -->
    <CountryCombobox
      class="mt-6"
      label="REGION"
      :options="countryOptions"
      :model-value="selectedCountry"
      @commit="pickCountry"
    />

    <!-- The quote it produced, or why there isn't one. -->
    <div class="mt-6 rounded-2xl bg-surface-container p-4">
      <!-- The chosen method is not routed for this region: offer the other method or the crypto
           route. -->
      <div v-if="session.meldMethodUnavailable" class="flex flex-col gap-3">
        <p v-if="otherMethodAvailable" class="text-sm text-text-secondary">
          {{ methodLabel(session.method === "bank" ? "bank" : "card") }} isn't available in this
          region, but {{ methodLabel(otherMethod).toLowerCase() }} is.
        </p>
        <p v-else class="text-sm text-text-secondary">
          This region isn't supported for card or bank right now. You can buy with crypto instead.
        </p>
        <button
          v-if="otherMethodAvailable"
          type="button"
          class="self-start rounded-full bg-action-secondary px-4 py-2 text-sm font-semibold"
          @click="useOtherMethod"
        >
          Use {{ methodLabel(otherMethod).toLowerCase() }}
        </button>
        <button
          v-else
          type="button"
          class="self-start rounded-full bg-action-secondary px-4 py-2 text-sm font-semibold"
          @click="useCryptoRoute"
        >
          Use crypto instead
        </button>
      </div>
      <div v-else-if="session.quoteError" class="flex flex-col gap-3">
        <p class="text-sm text-error">Quote failed: {{ session.quoteError }}</p>
        <button
          type="button"
          class="self-start rounded-full bg-action-secondary px-4 py-2 text-sm font-semibold"
          @click="requote"
        >
          Retry quote
        </button>
      </div>
      <div v-else-if="session.loading || !session.quoted" class="flex flex-col gap-3">
        <div v-for="n in 4" :key="n" class="flex h-6 items-center">
          <span
            class="h-4 animate-pulse rounded bg-action-secondary"
            :style="{ width: `${85 - n * 10}%` }"
          />
        </div>
      </div>
      <div v-else class="flex flex-col gap-4">
        <div
          v-for="row in quoteRows"
          :key="row.label"
          class="flex items-baseline justify-between gap-4"
        >
          <span class="text-sm text-text-secondary">{{ row.label }}</span>
          <span class="text-base" :class="{ 'font-semibold': row.label === 'You receive' }">{{
            row.value
          }}</span>
        </div>
      </div>
    </div>

    <p v-if="startError" class="mt-4 text-sm text-error">{{ startError }}</p>

    <button
      type="button"
      class="mt-auto mb-6 h-12 w-full rounded-full bg-action-primary text-base leading-6 font-semibold text-text-inverted disabled:bg-action-secondary disabled:text-text-disabled"
      :disabled="!canContinue"
      @click="next"
    >
      {{ starting ? "Starting…" : "Continue to payment" }}
    </button>
  </div>
</template>
