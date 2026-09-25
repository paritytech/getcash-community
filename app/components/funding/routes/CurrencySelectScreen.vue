<script setup lang="ts">
// The payment-region drill-in: the regions this rail can be paid from, each named by the currency
// it charges in. The device's own region leads as the detected one; everything else follows, and
// the regions that cannot take this purchase follow those, saying which of the two reasons it is.
// Picking commits and returns; nothing here re-quotes on its own.
import { computed, ref } from "vue";
import { regionForCountry } from "~~/lib/region";
import { regionGroups, trimAmount, type CountryOption } from "~~/lib/supported";
import { currencyName } from "../../../utils/currency";
import FlagCircle from "../../ui/FlagCircle.vue";
import SearchField from "../../ui/SearchField.vue";

const props = withDefaults(
  defineProps<{
    /** Every region the caller will accept, in its own order. A row carrying `disabled` or
     *  `belowMinimum` is listed under the reason it cannot be picked, and does not commit. */
    options: readonly CountryOption[];
    /** The committed region, as an ISO 3166-1 alpha-2 code. */
    modelValue: string;
    /** The region read off the device, shown first. Null when there is none, or it is not offered. */
    detected?: string | null;
    /** A pick is being carried out (the open request is being withdrawn): the list stops taking
     *  taps until it lands. */
    busy?: boolean;
    /** Why the last pick did not commit, when something refused it. The list stays open on the
     *  region it could not leave, so the reason has to be readable from here. */
    notice?: string | null;
    /** What the search field prompts for, when "currency" is not the word for this list. */
    placeholder?: string;
  }>(),
  { placeholder: "Search for a currency/country", notice: null },
);
const emit = defineEmits<{ pick: [country: string] }>();

const query = ref("");

/** The country's fiat: the corridor's own where the catalog priced one, else the region's, else
 *  null — a name we would have to guess is worse than no second line. */
function fiatFor(o: CountryOption): string | null {
  if (o.fiat) return o.fiat;
  const region = regionForCountry(o.country);
  return region.country === o.country ? region.fiat : null;
}

/**
 * The row's second line: what it costs to use this region, else the currency it charges in.
 *
 * The minimum leads wherever the catalog priced one, not only on the rows it puts out of reach.
 * The design draws it on the greyed rows alone, but a minimum is only known to bind when it is
 * written in the currency the quote is priced in — and the live corridors are nearly one country
 * per currency, so that gate hid the figure on every row it could have been read from.
 */
function subtitle(o: CountryOption): string | null {
  const fiat = fiatFor(o);
  if (o.min && fiat) return `Minimum for this country is ${trimAmount(o.min)} ${fiat}`;
  return fiat === null ? null : currencyName(fiat);
}

/** A row that says why it is listed but cannot be chosen. */
const unpickable = (o: CountryOption) => o.disabled === true || o.belowMinimum === true;

const filtering = computed(() => query.value.trim() !== "");

/** Matches the region's name, its currency's name, or either code. */
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (q === "") return props.options;
  return props.options.filter((o) => {
    const fiat = fiatFor(o);
    return (
      o.name.toLowerCase().includes(q) ||
      o.country.toLowerCase().startsWith(q) ||
      (fiat?.toLowerCase().startsWith(q) ?? false) ||
      (fiat !== null && currencyName(fiat).toLowerCase().includes(q))
    );
  });
});

/** One list with headed sections; a filter collapses the matches to the head of it. */
const sections = computed(() =>
  regionGroups(matches.value, props.detected ?? null, filtering.value),
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <SearchField
      v-model="query"
      class="shrink-0"
      :placeholder="placeholder"
      label="Search for a currency or country"
    />

    <p v-if="busy" class="mt-4 shrink-0 text-body-m text-fg-secondary" role="status">
      Switching currency…
    </p>
    <p v-else-if="notice" class="mt-4 shrink-0 text-body-m text-fg-secondary" role="status">
      {{ notice }}
    </p>

    <!-- The list scrolls under the search field; the negative margin lets a row's fill run the
         full width while the field keeps the screen's padding. -->
    <div class="-mx-6 mt-6 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
      <section v-for="(section, i) in sections" :key="section.title ?? `matches-${i}`">
        <h2 v-if="section.title" class="mb-3 text-body-m text-fg-secondary">{{ section.title }}</h2>
        <ul class="flex flex-col gap-2">
          <li v-for="option in section.rows" :key="option.country">
            <button
              type="button"
              :disabled="busy || unpickable(option)"
              class="flex w-full items-center gap-3 rounded-container py-2 pr-4 pl-2 text-left transition-colors"
              :class="[
                option.country === modelValue ? 'bg-surface-container' : '',
                unpickable(option)
                  ? 'cursor-default'
                  : 'hover:bg-surface-container disabled:opacity-50',
              ]"
              :aria-current="option.country === modelValue ? 'true' : undefined"
              @click="emit('pick', option.country)"
            >
              <!-- The flag stays in full colour on a row that cannot be picked: it is how the
                   buyer finds their own country in the list, greyed or not. -->
              <FlagCircle :country="option.country" :size="48" />
              <span class="flex min-w-0 flex-1 flex-col">
                <span
                  class="truncate text-heading-m"
                  :class="unpickable(option) ? 'text-fg-disabled' : 'text-fg-primary'"
                  >{{ option.name }}</span
                >
                <span
                  v-if="subtitle(option)"
                  class="truncate text-body-m"
                  :class="unpickable(option) ? 'text-fg-disabled' : 'text-fg-secondary'"
                >
                  {{ subtitle(option) }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <p v-if="matches.length === 0" class="text-body-m text-fg-secondary">
        No currency or country matches “{{ query }}”
      </p>
    </div>
  </div>
</template>
