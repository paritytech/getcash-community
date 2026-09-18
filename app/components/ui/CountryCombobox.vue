<script setup lang="ts">
// A country picker: a search field that opens a grouped list. Countries supported for the active
// method show their minimum; unsupported ones are greyed and non-selectable. `commit` fires only on
// a chosen country, never on filter text.
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown, Search } from "lucide-vue-next";
import {
  flagEmoji,
  firstSelectable,
  groupOptions,
  nextSelectable,
  trimAmount,
  type CountryOption,
} from "~~/lib/supported";

const props = defineProps<{
  /** Every country row, in the caller's order. A disabled row is greyed and non-selectable. */
  options: readonly CountryOption[];
  /** The committed selection, as an ISO 3166-1 alpha-2 code. */
  modelValue: string;
  label?: string;
  /** One line under the field saying what the choice means and what it changes. Wired to the input
   *  with `aria-describedby`, so a screen reader reads it with the field rather than after it. */
  hint?: string;
}>();
const emit = defineEmits<{ commit: [country: string] }>();

const open = ref(false);
/** The filter text. Empty means no filter; the committed country is `props.modelValue`. */
const query = ref("");
/** Index into `ordered` of the row the arrow keys are on; -1 means none. */
const active = ref(-1);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const selected = computed(() => props.options.find((o) => o.country === props.modelValue) ?? null);

/** The input's value when not being typed in: the selected country's name. */
const displayText = computed(() => selected.value?.name ?? "");

/** Whether to draw the flag adornment: a country is committed and the list is closed. */
const showFlag = computed(() => !open.value && selected.value !== null);

// Matches name or code case-insensitively. Name prefix matches first, then name substrings, then
// code prefixes.
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (q === "") return props.options;
  const starts: CountryOption[] = [];
  const contains: CountryOption[] = [];
  const byCode: CountryOption[] = [];
  for (const o of props.options) {
    const name = o.name.toLowerCase();
    if (name.startsWith(q)) starts.push(o);
    else if (name.includes(q)) contains.push(o);
    else if (o.country.toLowerCase().startsWith(q)) byCode.push(o);
  }
  return [...starts, ...contains, ...byCode];
});

// The detected country pins to the top; the rest split into supported (with a min) and greyed. The
// grouping + flat `ordered` nav order live in a pure helper so they can be unit-tested.
const grouped = computed(() => groupOptions(filtered.value, props.modelValue));
const ordered = computed(() => grouped.value.ordered);
const groups = computed(() => grouped.value.groups);

// The line under a country's name: its minimum, or why it is unavailable.
function subtitle(o: CountryOption): string {
  if (o.disabled) return "Payments here aren't supported";
  if (o.min !== undefined && o.currency !== undefined)
    return `Minimum for this country is ${trimAmount(o.min)} ${o.currency}`;
  return "";
}

watch(ordered, (rows) => {
  if (active.value >= rows.length) active.value = rows.length - 1;
  // Keep the highlight off a greyed row when the list changes under it (e.g. corridors load while open).
  if (active.value >= 0 && rows[active.value]?.disabled) active.value = firstSelectable(rows);
});

function openList() {
  if (open.value) return;
  open.value = true;
  // Opens with the whole list and the committed country highlighted, unless it is disabled.
  query.value = "";
  const committed = ordered.value.findIndex((o) => o.country === props.modelValue && !o.disabled);
  active.value = committed >= 0 ? committed : firstSelectable(ordered.value);
  void scrollActiveIntoView();
}

/** Closes without committing; the previous selection stands. */
function close() {
  open.value = false;
  query.value = "";
  active.value = -1;
}

function choose(country: string) {
  // A disabled row never commits.
  if (props.options.find((o) => o.country === country)?.disabled) return;
  close();
  // Re-choosing the committed country does not emit.
  if (country !== props.modelValue) emit("commit", country);
}

async function scrollActiveIntoView() {
  await nextTick();
  const row = listEl.value?.querySelector<HTMLElement>('[data-active="true"]');
  row?.scrollIntoView({ block: "nearest" });
}

function move(delta: number) {
  if (!open.value) {
    openList();
    return;
  }
  // Arrow keys land only on selectable rows, wrapping past greyed ones.
  active.value = nextSelectable(ordered.value, active.value, delta);
  void scrollActiveIntoView();
}

function onEnter() {
  if (!open.value) return;
  const row = ordered.value[active.value];
  if (row) choose(row.country);
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  open.value = true;
  // Points at the best selectable match, or at nothing when none is selectable.
  active.value = firstSelectable(ordered.value);
}

// Rows commit on `mousedown.prevent`, which keeps focus on the input.
function onBlur() {
  close();
}

const listboxId = `country-listbox-${Math.random().toString(36).slice(2, 8)}`;
const hintId = `${listboxId}-hint`;
const rowId = (i: number) => `${listboxId}-row-${i}`;
</script>

<template>
  <div class="flex flex-col gap-2">
    <span v-if="label" class="text-overline text-fg-tertiary">{{ label }}</span>
    <div class="relative">
      <!-- The selected country's flag, over the field's left padding. Hidden while the list is open. -->
      <span
        v-if="showFlag"
        class="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-body-l"
        aria-hidden="true"
        >{{ flagEmoji(modelValue) }}</span
      >
      <!-- The search glyph the open list shows in the flag's place. -->
      <Search
        v-else-if="open"
        class="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-fg-secondary"
        aria-hidden="true"
      />
      <input
        ref="inputEl"
        type="text"
        role="combobox"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        :aria-expanded="open"
        :aria-controls="listboxId"
        aria-autocomplete="list"
        :aria-activedescendant="open && active >= 0 ? rowId(active) : undefined"
        :aria-describedby="hint ? hintId : undefined"
        :value="open ? query : displayText"
        :placeholder="open ? 'Search for a country' : selected ? '' : 'Search for a country'"
        class="w-full rounded-nested bg-surface-container py-3 text-body-l text-fg-primary placeholder:text-fg-tertiary"
        :class="[showFlag || open ? 'pl-11' : 'pl-4', open ? 'pr-4' : 'pr-10']"
        @focus="openList"
        @input="onInput"
        @blur="onBlur"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="onEnter"
        @keydown.esc.prevent="close"
        @keydown.tab="close"
      />
      <!-- The chevron the native select would have drawn (appearance-none removed it). -->
      <ChevronDown
        v-if="!open"
        class="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-fg-secondary"
        aria-hidden="true"
      />

      <ul
        v-if="open"
        :id="listboxId"
        ref="listEl"
        role="listbox"
        class="absolute top-full right-0 left-0 z-10 mt-3 max-h-96 overflow-y-auto rounded-nested bg-surface-container pt-2 pb-3 shadow-2"
      >
        <li
          v-for="(grp, gi) in groups"
          :key="grp.label"
          role="group"
          :aria-labelledby="`${listboxId}-grp-${gi}`"
          class="block"
        >
          <span
            :id="`${listboxId}-grp-${gi}`"
            class="block px-4 pt-4 pb-2 text-overline text-fg-tertiary"
            >{{ grp.label }}</span
          >
          <div
            v-for="row in grp.options"
            :id="rowId(row.index)"
            :key="row.o.country"
            role="option"
            :aria-selected="row.o.country === modelValue && !row.o.disabled"
            :aria-disabled="row.o.disabled ? 'true' : undefined"
            :data-active="row.index === active"
            class="flex items-center gap-3 px-4 py-2.5 data-[active=true]:bg-selection-container-hover"
            :class="row.o.disabled ? 'cursor-not-allowed' : 'cursor-pointer'"
            @mousedown.prevent="choose(row.o.country)"
            @mousemove="row.o.disabled || (active = row.index)"
          >
            <span
              class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-nested text-body-l"
              :class="row.o.disabled ? 'opacity-40' : ''"
              aria-hidden="true"
              >{{ flagEmoji(row.o.country) }}</span
            >
            <span class="flex min-w-0 flex-col">
              <span
                class="truncate text-body-l"
                :class="row.o.disabled ? 'text-fg-tertiary' : 'text-fg-primary'"
                >{{ row.o.name }}</span
              >
              <span
                v-if="subtitle(row.o)"
                class="truncate text-body-m"
                :class="row.o.disabled ? 'text-fg-tertiary' : 'text-fg-secondary'"
                >{{ subtitle(row.o) }}</span
              >
            </span>
          </div>
        </li>
        <li
          v-if="ordered.length === 0"
          role="presentation"
          class="px-4 py-2.5 text-body-m text-fg-secondary"
        >
          No country matches “{{ query }}”
        </li>
      </ul>
    </div>
    <!-- Sits OUTSIDE the relative wrapper the list is absolutely positioned in, so an open list
         covers the rows below the field rather than this line. -->
    <p v-if="hint" :id="hintId" class="text-body-m text-fg-secondary">{{ hint }}</p>
  </div>
</template>
