<script setup lang="ts">
// A filtering country picker: a text input plus a filtered list of flag/name rows. Typing filters;
// selecting commits. `commit` fires only on a chosen country, never on filter text.
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { flagEmoji } from "~~/lib/supported";

const props = defineProps<{
  /** Every selectable country, in the caller's order. */
  options: readonly { country: string; name: string }[];
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
/** Index into `filtered` of the row the arrow keys are on; -1 means none. */
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
  type Row = { country: string; name: string };
  const starts: Row[] = [];
  const contains: Row[] = [];
  const byCode: Row[] = [];
  for (const o of props.options) {
    const name = o.name.toLowerCase();
    if (name.startsWith(q)) starts.push(o);
    else if (name.includes(q)) contains.push(o);
    else if (o.country.toLowerCase().startsWith(q)) byCode.push(o);
  }
  return [...starts, ...contains, ...byCode];
});

watch(filtered, (rows) => {
  if (active.value >= rows.length) active.value = rows.length - 1;
});

function openList() {
  if (open.value) return;
  open.value = true;
  // Opens with the whole list and the committed country highlighted.
  query.value = "";
  active.value = props.options.findIndex((o) => o.country === props.modelValue);
  void scrollActiveIntoView();
}

/** Closes without committing; the previous selection stands. */
function close() {
  open.value = false;
  query.value = "";
  active.value = -1;
}

function choose(country: string) {
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
  const rows = filtered.value;
  if (rows.length === 0) return;
  active.value = (active.value + delta + rows.length) % rows.length;
  void scrollActiveIntoView();
}

function onEnter() {
  if (!open.value) return;
  const row = filtered.value[active.value];
  if (row) choose(row.country);
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  open.value = true;
  // Points at the best match, or at nothing when the filter matches nothing.
  active.value = filtered.value.length > 0 ? 0 : -1;
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
      <!-- The selected country's flag, drawn over the field's left padding. Hidden while the list is
           open. -->
      <span
        v-if="showFlag"
        class="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-body-l"
        aria-hidden="true"
        >{{ flagEmoji(modelValue) }}</span
      >
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
        :placeholder="selected ? '' : 'Search countries'"
        class="w-full rounded-nested bg-surface-container py-3 pr-10 text-body-l text-fg-primary placeholder:text-fg-tertiary"
        :class="showFlag ? 'pl-11' : 'pl-4'"
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
        class="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-fg-secondary"
        aria-hidden="true"
      />

      <ul
        v-if="open"
        :id="listboxId"
        ref="listEl"
        role="listbox"
        class="absolute top-full right-0 left-0 z-10 mt-1 max-h-64 overflow-y-auto rounded-nested bg-surface-container py-1 shadow-2"
      >
        <li
          v-for="(o, i) in filtered"
          :id="rowId(i)"
          :key="o.country"
          role="option"
          :aria-selected="o.country === modelValue"
          :data-active="i === active"
          class="cursor-pointer px-4 py-2.5 text-body-l text-fg-primary data-[active=true]:bg-selection-container-hover"
          @mousedown.prevent="choose(o.country)"
          @mousemove="active = i"
        >
          <span class="mr-2">{{ flagEmoji(o.country) }}</span
          >{{ o.name }}
        </li>
        <li v-if="filtered.length === 0" class="px-4 py-2.5 text-body-m text-fg-secondary">
          No country matches “{{ query }}”
        </li>
      </ul>
    </div>
    <!-- Sits OUTSIDE the relative wrapper the list is absolutely positioned in, so an open list
         covers the rows below the field rather than this line. -->
    <p v-if="hint" :id="hintId" class="text-sm text-text-secondary">{{ hint }}</p>
  </div>
</template>
