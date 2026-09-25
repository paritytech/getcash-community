<script setup lang="ts">
// The Meld package's first screen: region, the quote it produced, and Continue into the provider
// widget. The method is fixed by the route; the region is the buyer's only choice.
import { computed, onMounted, ref, watch } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { useSessionStore } from "../../../stores/session";
import { namedCountry } from "~~/lib/supported";
import { localeCountry } from "../../../utils/locale";
import { fmtFiat, isMoneyAmount } from "../../../utils/money";
import type { FundingRoute } from "../../../funding/selection";
import DetailRows from "../../ui/DetailRows.vue";
import PillButton from "../../ui/PillButton.vue";
import RegionRow from "../../ui/RegionRow.vue";
import SecondaryButton from "../../ui/SecondaryButton.vue";
import SkeletonBlock from "../../ui/SkeletonBlock.vue";

const session = useSessionStore();
// switchRoute asks the shell to swap to the crypto package when this region routes neither card
// nor bank; fees opens the fee-breakdown drill-in, currency the region picker.
const emit = defineEmits<{ switchRoute: [route: FundingRoute]; fees: []; currency: [] }>();

// The adapter's buyer-facing refusal message, shown under the quote and blocking Continue.
const startError = ref<string | null>(null);

/** The region shown before the buyer picks one; matches the quoter's own default region. */
const DEFAULT_COUNTRY = "US";

// The shown country matches the quoted region.
const selectedCountry = computed(() => session.meldCountry ?? DEFAULT_COUNTRY);
/** The region's own name, as the live catalog writes it; Intl names the ones it did not. */
const countryLabel = computed(() =>
  namedCountry(selectedCountry.value, session.supportedCountries),
);

// Adopts the default region and quotes when none is chosen, then loads the full catalog. A catalog
// failure leaves the fallback list in place.
onMounted(() => {
  if (session.meldCountry === null) {
    session.setMeldCountry(localeCountry() ?? DEFAULT_COUNTRY);
    requote();
  }
});
// Re-quoting clears a previous refusal.
function requote() {
  startError.value = null;
  void session.fetchMeldQuote();
}
// So does changing region: the refusal the last one earned is not this one's, and it would
// otherwise keep Continue disabled for a payment that was never refused. The picker lives in the
// route, so the region is watched rather than handed over.
watch(
  () => session.meldCountry,
  () => {
    startError.value = null;
  },
);

// When the chosen method is not routed for this region, offers the other method if the corridor has
// it, otherwise the crypto route.
const otherMethod = computed<"card" | "bank">(() => (session.method === "bank" ? "card" : "bank"));
const otherMethodAvailable = computed(() =>
  (session.meldCorridor?.methods ?? []).some((m) => m.category === otherMethod.value),
);
const methodLabel = (m: "card" | "bank") => (m === "bank" ? "Bank transfer" : "Card");
function useOtherMethod() {
  // Through the shell, not `setMethod`: each method has its own package screen, and swapping the
  // method under this one would leave a bank transfer being made on the card screen.
  emit("switchRoute", otherMethod.value);
}
function useCryptoRoute() {
  emit("switchRoute", "crypto");
}

// The charged total is the hero; the toolbar already names the method, so no Via row.
const heroAmount = computed(() => {
  const q = session.quoted;
  return q ? fmtFiat(q.send, q.symbol) : null;
});
// The caption states the charge is fee-inclusive and is itself the way into the breakdown, so the
// quote no longer spends a row on a fee it has already accounted for.
const heroCaption = computed(() =>
  session.method === "bank"
    ? "Will be charged to the bank account inc. fees"
    : "Will be charged to the card inc. fees",
);

/**
 * How long this rail takes to land. This screen serves both Meld methods and, with the Via row
 * gone, this row is the only timing statement on it: a bank transfer must not inherit the card's
 * "a few minutes". Matches the selector's own word on the bank route.
 */
const arrivesText = computed(() =>
  session.method === "bank" ? "1-2 business days" : "A few minutes",
);

/** The caption drills in only when the fee is a number the breakdown can actually split. */
const canOpenFees = computed(() => {
  const q = session.quoted;
  return !!q?.fee && isMoneyAmount(q.fee);
});

const quoteRows = computed(() => {
  const q = session.quoted;
  if (!q) return [];
  // What the money buys leads; when it lands follows. Provider and region are settings rather
  // than terms, and the picker above already names the region.
  return [
    { label: "You’ll receive", value: session.amountHuman, cash: true },
    { label: "Arrives", value: arrivesText.value },
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
        <button
          v-if="canOpenFees"
          type="button"
          class="flex items-center gap-2 text-paragraph-l text-fg-secondary"
          @click="emit('fees')"
        >
          {{ heroCaption }}
          <ChevronRight class="size-4" aria-hidden="true" />
        </button>
        <p v-else class="text-paragraph-l text-fg-secondary">{{ heroCaption }}</p>
      </template>
      <template v-else>
        <SkeletonBlock class="h-16 w-44" />
        <SkeletonBlock class="mt-3 h-5 w-28" />
      </template>
    </div>

    <!-- The region the card is registered in leads the terms, and is live even while the quote
         below it is blocked: changing it is the way out of a region that routes nothing. -->
    <div class="mt-6 flex flex-col gap-4">
      <RegionRow
        label="Payment country"
        :value="countryLabel"
        :country="selectedCountry"
        @open="emit('currency')"
      />

      <!-- The quote's own rows, bare on the surface. -->
      <template v-if="!session.meldMethodUnavailable && !session.quoteError">
        <div v-if="session.loading || !session.quoted" class="flex flex-col gap-4">
          <div v-for="n in 2" :key="n" class="flex h-6 items-center justify-between">
            <SkeletonBlock class="h-4 w-2/5" />
            <SkeletonBlock class="h-4 w-1/5" />
          </div>
        </div>
        <DetailRows v-else :rows="quoteRows" />
      </template>
    </div>

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
        <SecondaryButton
          class="self-start"
          @click="otherMethodAvailable ? useOtherMethod() : useCryptoRoute()"
        >
          {{
            otherMethodAvailable
              ? `Use ${methodLabel(otherMethod).toLowerCase()}`
              : "Use crypto instead"
          }}
        </SecondaryButton>
      </div>
      <div v-else class="flex flex-col gap-3">
        <p class="text-body-m text-fg-error">Quote failed: {{ session.quoteError }}</p>
        <SecondaryButton class="self-start" @click="requote">Retry quote</SecondaryButton>
      </div>
    </div>

    <p v-if="startError" class="mt-4 text-body-m text-fg-error">{{ startError }}</p>

    <PillButton class="mt-auto mb-6 w-full" :disabled="!canContinue" @click="next">
      {{ starting ? "Starting…" : "Continue" }}
    </PillButton>
  </div>
</template>
