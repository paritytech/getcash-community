<script setup lang="ts" generic="T extends OptionListRow">
// A picker's rows as one unlabelled list of OptionRow cards: the ones that can be picked first,
// then the ones that cannot, outlined and saying why. While `loading`, skeleton rows stand in
// for the list, one per row, so nothing moves when the rows arrive.
import { computed } from "vue";
import { sortPickable, type OptionListRow } from "../../utils/option-list";

const props = withDefaults(
  defineProps<{
    rows: readonly T[];
    /** The rows are still being answered: skeletons stand in, one per row. */
    loading?: boolean;
    /** What the list holds, for assistive tech ("Networks"). */
    label: string;
  }>(),
  { loading: false },
);
const emit = defineEmits<{ pick: [row: T] }>();

const sorted = computed(() => sortPickable(props.rows));
</script>

<template>
  <!-- The cards bleed past the 24px content gutter to the design's 16px inset. -->
  <ul
    v-if="loading"
    class="-mx-2 flex flex-col gap-2"
    :aria-label="`Loading ${label.toLowerCase()}`"
  >
    <OptionRow v-for="n in rows.length" :key="n" skeleton />
  </ul>

  <ul v-else class="-mx-2 flex min-h-0 flex-col gap-2 overflow-y-auto pb-6" :aria-label="label">
    <OptionRow
      v-for="row in sorted"
      :key="row.key"
      :icon="row.icon"
      :label="row.label"
      :subtitle="row.subtitle"
      :disabled="!row.pickable"
      :busy="row.busy"
      @select="emit('pick', row)"
    />
  </ul>
</template>
