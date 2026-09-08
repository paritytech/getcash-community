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

/**
 * The device's own region, e.g. "BR" for a pt-BR phone.
 *
 * Testers landed on the screen already quoting US and did not read the picker as something they had
 * to change, so a Brazilian card was priced against a US corridor and declined. The device locale is
 * the closest thing to the buyer's real region available without the geolocation scope: still a
 * guess, but a guess drawn from the buyer rather than from us. Returns null on anything that is not
 * a plain alpha-2 region, so the caller keeps DEFAULT_COUNTRY.
 */
function localeCountry(): string | null {
  if (typeof navigator === "undefined") return null;
  const tag = navigator.language;
  if (!tag) return null;
  try {
    // `maximize()` supplies the region a bare language tag omits ("pt" -> "pt-Latn-BR").
    const region = new Intl.Locale(tag).maximize().region;
    return region !== undefined && /^[A-Z]{2}$/.test(region) ? region : null;
  } catch {
    return null;
  }
}

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
    session.setMeldCountry(localeCountry() ?? DEFAULT_COUNTRY);
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

// The charged total is the hero; the toolbar already names the method, so no Via row.
const heroAmount = computed(() => {
  const q = session.quoted;
  return q ? `${q.send} ${q.symbol}` : null;
});
const heroCaption = computed(() =>
  session.method === "bank"
    ? "Will be charged from your bank account"
    : "Will be charged from your card",
);

/** The picked region's own name, for the quote's terms. Falls back to the code when the catalog is
 *  the static list and the code is not in it. */
const selectedCountryName = computed(
  () =>
    countryOptions.value.find((o) => o.country === selectedCountry.value)?.name ??
    selectedCountry.value,
);

const quoteRows = computed(() => {
  if (!session.quoted) return [];
  // No Fees row yet: the quote carries no fee breakdown.
  return [
    { label: "Provider", value: "Meld" },
    // Names the corridor these terms were priced against. Two Card failures in one testathon
    // session came from two DIFFERENT regions, and nothing on the quote said which one it was.
    { label: "Region", value: selectedCountryName.value },
    { label: "Arrives", value: "A few minutes" },
    { label: "You’ll receive", value: `${session.amountHuman} CASH` },
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
    <!-- The hero: the total the card will be charged. The toolbar already names the method. -->
    <div
      v-if="!session.meldMethodUnavailable && !session.quoteError"
      class="flex flex-col items-center text-center"
    >
      <template v-if="heroAmount">
        <p class="text-display-xl text-fg-primary">{{ heroAmount }}</p>
        <p class="text-paragraph-l text-fg-secondary">{{ heroCaption }}</p>
      </template>
      <template v-else>
        <span class="h-16 w-44 animate-pulse rounded-full bg-action-disabled" />
        <span class="mt-3 h-5 w-28 animate-pulse rounded-full bg-action-disabled" />
      </template>
    </div>

    <!-- Temporary region picker, removed once geolocation lands. -->
    <CountryCombobox
      class="mt-6"
      label="CARD OR BANK COUNTRY"
      hint="Where your card or bank account is registered. This sets which providers and payment methods you can use."
      :options="countryOptions"
      :model-value="selectedCountry"
      @commit="pickCountry"
    />

    <!-- Why there is no quote. These states have no design; they keep the card treatment. -->
    <div
      v-if="session.meldMethodUnavailable || session.quoteError"
      class="mt-6 rounded-container bg-surface-container p-4 shadow-1"
    >
      <!-- The chosen method is not routed for this region: offer the other method or the crypto
           route. -->
      <div v-if="session.meldMethodUnavailable" class="flex flex-col gap-3">
        <p v-if="otherMethodAvailable" class="text-body-m text-fg-secondary">
          {{ methodLabel(session.method === "bank" ? "bank" : "card") }} isn't available in this
          region, but {{ methodLabel(otherMethod).toLowerCase() }} is.
        </p>
        <p v-else class="text-body-m text-fg-secondary">
          This region isn't supported for card or bank right now. You can buy with crypto instead.
        </p>
        <button
          v-if="otherMethodAvailable"
          type="button"
          class="self-start rounded-medium bg-action-secondary px-4 py-2 text-label-m text-fg-primary transition-colors hover:bg-action-secondary-hover"
          @click="useOtherMethod"
        >
          Use {{ methodLabel(otherMethod).toLowerCase() }}
        </button>
        <button
          v-else
          type="button"
          class="self-start rounded-medium bg-action-secondary px-4 py-2 text-label-m text-fg-primary transition-colors hover:bg-action-secondary-hover"
          @click="useCryptoRoute"
        >
          Use crypto instead
        </button>
      </div>
      <div v-else class="flex flex-col gap-3">
        <p class="text-body-m text-fg-error">Quote failed: {{ session.quoteError }}</p>
        <button
          type="button"
          class="self-start rounded-medium bg-action-secondary px-4 py-2 text-label-m text-fg-primary transition-colors hover:bg-action-secondary-hover"
          @click="requote"
        >
          Retry quote
        </button>
      </div>
    </div>

    <!-- The quote's detail rows, bare on the surface. -->
    <div v-else-if="session.loading || !session.quoted" class="mt-6 flex flex-col gap-4">
      <div v-for="n in 3" :key="n" class="flex h-6 items-center justify-between">
        <span class="h-4 w-2/5 animate-pulse rounded-full bg-action-disabled" />
        <span class="h-4 w-1/5 animate-pulse rounded-full bg-action-disabled" />
      </div>
    </div>
    <div v-else class="mt-6 flex flex-col gap-4">
      <div
        v-for="row in quoteRows"
        :key="row.label"
        class="flex items-baseline justify-between gap-4"
      >
        <span class="text-paragraph-l text-fg-primary">{{ row.label }}</span>
        <span class="text-heading-m text-fg-primary">{{ row.value }}</span>
      </div>
    </div>

    <p v-if="startError" class="mt-4 text-body-m text-fg-error">{{ startError }}</p>

    <button
      type="button"
      class="mt-auto mb-6 h-12 w-full rounded-full bg-action-primary text-label-l font-semibold text-fg-primary-inverted transition-colors hover:bg-action-primary-hover disabled:bg-action-disabled disabled:text-fg-disabled"
      :disabled="!canContinue"
      @click="next"
    >
      {{
        starting
          ? "Starting…"
          : session.method === "bank"
            ? "Enter bank details"
            : "Enter card details"
      }}
    </button>
  </div>
</template>
