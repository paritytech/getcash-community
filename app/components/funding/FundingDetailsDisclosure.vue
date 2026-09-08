<script setup lang="ts">
import { computed } from "vue";
import type { FundingStatusDetail } from "../../funding/status";
import FundingDisclosure from "./FundingDisclosure.vue";

const props = defineProps<{ rows: readonly FundingStatusDetail[] }>();

const summary = computed(() =>
  ["token", "network", "provider"]
    .flatMap((key) => {
      const row = props.rows.find((candidate) => candidate.key === key);
      return row ? [row.value] : [];
    })
    .join(" · "),
);
</script>

<template>
  <FundingDisclosure title="Details">
    <template #summary>
      <span v-if="summary" class="funding-details-summary text-caption">{{ summary }}</span>
    </template>

    <dl class="funding-details-list">
      <div v-for="row in rows" :key="row.key" class="funding-details-row">
        <dt class="text-body-m">
          <img v-if="row.icon" :src="row.icon" alt="" />
          <span>{{ row.label }}</span>
        </dt>
        <dd :class="row.monospace ? 'font-mono text-code' : 'text-heading-s'">
          {{ row.value }}
        </dd>
      </div>
    </dl>
  </FundingDisclosure>
</template>

<style scoped>
.funding-details-summary {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  overflow: hidden;
  color: var(--fg-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-details-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.funding-details-row {
  display: flex;
  min-height: 1.5rem;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.funding-details-row dt {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  color: var(--fg-secondary);
}

.funding-details-row dt img {
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
  border-radius: 9999px;
}

.funding-details-row dd {
  min-width: 0;
  color: var(--fg-primary);
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
