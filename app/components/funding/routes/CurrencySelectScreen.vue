<script setup lang="ts">
// The "Choose a currency" drill-in: the regions this rail can be paid from, each named by the
// currency it charges in. The device's own region leads as the detected one; everything else
// follows. Picking commits and returns; nothing here re-quotes on its own.
import { computed, ref } from "vue";
import { regionForCountry } from "~~/lib/region";
import { currencyName } from "../../../utils/currency";
import FlagCircle from "../../ui/FlagCircle.vue";
import SearchField from "../../ui/SearchField.vue";

const props = defineProps<{
  /** Every region the caller will accept, in its own order. */
  options: readonly { country: string; name: string }[];
  /** The committed region, as an ISO 3166-1 alpha-2 code. */
  modelValue: string;
  /** The region read off the device, shown first. Null when there is none, or it is not offered. */
  detected?: string | null;
  /** A pick is being carried out (the open request is being withdrawn): the list stops taking
   *  taps until it lands. */
  busy?: boolean;
}>();
const emit = defineEmits<{ pick: [country: string] }>();

const query = ref("");

/** The country's fiat, or null when we have no fiat for it (its name would be a guess). */
function fiatFor(country: string): string | null {
  const region = regionForCountry(country);
  return region.country === country ? region.fiat : null;
}

/** The row's second line: the currency the region is charged in. */
function currencyFor(country: string): string | null {
  const fiat = fiatFor(country);
  return fiat === null ? null : currencyName(fiat);
}

const detectedOption = computed(() =>
  props.detected ? (props.options.find((o) => o.country === props.detected) ?? null) : null,
);

/** Matches the region's name, its currency's name, or its code. */
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (q === "") return props.options;
  return props.options.filter(
    (o) =>
      o.name.toLowerCase().includes(q) ||
      o.country.toLowerCase().startsWith(q) ||
      (currencyFor(o.country)?.toLowerCase().includes(q) ?? false) ||
      (fiatFor(o.country)?.toLowerCase().startsWith(q) ?? false),
  );
});

/** One list with headed sections; a filter collapses it to the bare matches. */
const sections = computed<
  { title: string | null; rows: readonly { country: string; name: string }[] }[]
>(() => {
  if (query.value.trim() !== "") return [{ title: null, rows: matches.value }];
  const all = { title: "All currencies", rows: props.options };
  return detectedOption.value
    ? [{ title: "Detected currency", rows: [detectedOption.value] }, all]
    : [all];
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <SearchField
      v-model="query"
      class="shrink-0"
      placeholder="Search for a currency/country"
      label="Search for a currency or country"
    />

    <p v-if="busy" class="mt-4 shrink-0 text-body-m text-fg-secondary" role="status">
      Switching currency…
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
              :disabled="busy"
              class="flex w-full items-center gap-3 rounded-container py-2 pr-4 pl-2 text-left transition-colors disabled:opacity-50"
              :class="
                option.country === modelValue
                  ? 'bg-surface-container'
                  : 'hover:bg-surface-container'
              "
              :aria-current="option.country === modelValue ? 'true' : undefined"
              @click="emit('pick', option.country)"
            >
              <FlagCircle :country="option.country" :size="48" />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-heading-m text-fg-primary">{{ option.name }}</span>
                <span
                  v-if="currencyFor(option.country)"
                  class="truncate text-body-m text-fg-secondary"
                >
                  {{ currencyFor(option.country) }}
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
