<script setup lang="ts">
// The Meld sell's first screen: region, the crypto this withdrawal commits (exact), the fiat the
// quote estimates for it, and Continue into the provider's KYC widget. Shaped like the buy side's
// `MeldPayScreen.vue` on purpose — region picker, hero amount, detail rows, the same "switch
// method / switch route" fallback — but the hero here is the exact committed crypto, never the
// estimate, since a sell has nothing to charge and everything to promise carefully.
import { computed } from "vue";
import { ChevronRight } from "lucide-vue-next";
import type { CountryOption } from "~~/lib/supported";
import CountryCombobox from "../ui/CountryCombobox.vue";
import DetailRows from "../ui/DetailRows.vue";
import PillButton from "../ui/PillButton.vue";
import SecondaryButton from "../ui/SecondaryButton.vue";
import SkeletonBlock from "../ui/SkeletonBlock.vue";

const props = defineProps<{
  method: "card" | "bank";
  country: string;
  countryOptions: readonly CountryOption[];
  /** The exact crypto this withdrawal commits, formatted; null while it is still being sized. */
  committedText: string | null;
  /** The estimated fiat payout, formatted and "≈"-prefixed; null without a quote. */
  payoutText: string | null;
  committing: boolean;
  loading: boolean;
  /** This region does not route `method` at all. */
  unavailable: boolean;
  commitError: string | null;
  quoteError: string | null;
  otherMethodLabel: string;
  otherMethodAvailable: boolean;
  canContinue: boolean;
  starting: boolean;
  startError: string | null;
}>();
const emit = defineEmits<{
  pickCountry: [country: string];
  retry: [];
  useOtherMethod: [];
  useCrypto: [];
  fees: [];
  continue: [];
}>();

const methodLabel = computed(() => (props.method === "bank" ? "Bank transfer" : "Card"));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The hero: the exact crypto this withdrawal commits. Never the fiat -- that figure is an
         estimate and does not get top billing. -->
    <div v-if="!unavailable && !commitError" class="flex flex-col items-center text-center">
      <template v-if="committedText">
        <p class="text-display-xl text-fg-primary">{{ committedText }}</p>
        <button
          v-if="payoutText"
          type="button"
          class="flex items-center gap-2 text-paragraph-l text-fg-secondary"
          @click="emit('fees')"
        >
          You'll receive {{ payoutText }}
          <ChevronRight class="size-4" aria-hidden="true" />
        </button>
        <p v-else class="text-paragraph-l text-fg-secondary">Pricing your payout…</p>
      </template>
      <template v-else>
        <SkeletonBlock class="h-16 w-44" />
        <SkeletonBlock class="mt-3 h-5 w-28" />
      </template>
    </div>

    <CountryCombobox
      class="mt-6"
      label="PAYOUT COUNTRY"
      hint="Where your card or bank account is registered. This sets which providers and payout methods you can use."
      :options="countryOptions"
      :model-value="country"
      @commit="emit('pickCountry', $event)"
    />

    <div
      v-if="unavailable || commitError || quoteError"
      class="mt-6 rounded-container bg-surface-container p-4 shadow-1"
    >
      <!-- `unavailable` is read off the adapter's own sell corridor catalog (see
           `../../withdraw/meld-corridors`), so this is a fact about the region rather than a
           guess drawn from the buy catalog: say it plainly instead of hedging. -->
      <div v-if="unavailable" class="flex flex-col gap-3">
        <p v-if="otherMethodAvailable" class="text-body-m text-fg-secondary">
          {{ methodLabel }} payouts aren't available for this region yet, but
          {{ otherMethodLabel.toLowerCase() }} might work.
        </p>
        <p v-else class="text-body-m text-fg-secondary">
          Card and bank payouts aren't available for this region yet. You can withdraw as crypto
          instead.
        </p>
        <SecondaryButton
          class="self-start"
          @click="otherMethodAvailable ? emit('useOtherMethod') : emit('useCrypto')"
        >
          {{
            otherMethodAvailable ? `Use ${otherMethodLabel.toLowerCase()}` : "Use crypto instead"
          }}
        </SecondaryButton>
      </div>
      <div v-else class="flex flex-col gap-3">
        <p class="text-body-m text-fg-error">
          {{
            commitError
              ? `Could not price this withdrawal: ${commitError}`
              : `Quote failed: ${quoteError}`
          }}
        </p>
        <SecondaryButton class="self-start" @click="emit('retry')">Retry</SecondaryButton>
      </div>
    </div>

    <div v-else-if="committing || loading || !payoutText" class="mt-6 flex flex-col gap-4">
      <div v-for="n in 1" :key="n" class="flex h-6 items-center justify-between">
        <SkeletonBlock class="h-4 w-2/5" />
        <SkeletonBlock class="h-4 w-1/5" />
      </div>
    </div>
    <DetailRows v-else class="mt-6" :rows="[{ label: 'Paid out via', value: methodLabel }]" />

    <p v-if="startError" class="mt-4 text-body-m text-fg-error">{{ startError }}</p>

    <PillButton class="mt-auto mb-6 w-full" :disabled="!canContinue" @click="emit('continue')">
      {{ starting ? "Starting…" : "Continue" }}
    </PillButton>
  </div>
</template>
