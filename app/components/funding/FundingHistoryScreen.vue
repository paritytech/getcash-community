<script setup lang="ts">
import { computed } from "vue";
import { ChevronLeft } from "lucide-vue-next";
import type { FundingSelectorConfig } from "../../funding/config";
import { formatFundingHistoryWhen } from "../../funding/history";
import type { InProgressFundingTopUp, PastFundingTopUp } from "../../funding/top-ups";
import FundingProgressRing from "./progress/FundingProgressRing.vue";

const props = defineProps<{
  config: FundingSelectorConfig;
  inProgress: readonly InProgressFundingTopUp[];
  past: readonly PastFundingTopUp[];
  openingTopUpId?: string | null;
  error?: string | null;
}>();

const emit = defineEmits<{
  back: [];
  open: [topUp: InProgressFundingTopUp];
}>();

const empty = computed(() => props.inProgress.length === 0 && props.past.length === 0);
</script>

<template>
  <div class="funding-history-screen">
    <header class="funding-history-header">
      <button type="button" aria-label="Back" @click="emit('back')">
        <ChevronLeft class="size-6" aria-hidden="true" />
      </button>
      <h1 class="text-heading-l">History</h1>
    </header>

    <div class="funding-history-scroll">
      <section v-if="inProgress.length > 0">
        <h2 class="text-overline">In progress</h2>
        <ul class="funding-history-list">
          <li v-for="topUp in inProgress" :key="topUp.id">
            <button
              type="button"
              class="funding-history-row"
              :disabled="Boolean(openingTopUpId)"
              @click="emit('open', topUp)"
            >
              <FundingProgressRing :progress="topUp.progress" />
              <span class="funding-history-main">
                <strong class="text-heading-s">{{ topUp.amount }} {{ config.asset }}</strong>
                <span class="funding-history-status text-caption">
                  {{ openingTopUpId === topUp.id ? "Opening…" : topUp.progress.view.label }}
                </span>
              </span>
              <span class="funding-history-value">
                <strong class="text-heading-s">{{ topUp.amount }}</strong>
                <span class="text-caption">{{ formatFundingHistoryWhen(topUp.startedAt) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="past.length > 0" :class="{ 'funding-history-earlier': inProgress.length > 0 }">
        <h2 class="text-overline">Earlier</h2>
        <ul class="funding-history-list">
          <li v-for="topUp in past" :key="topUp.id">
            <div class="funding-history-row">
              <FundingProgressRing :progress="topUp.progress" />
              <span class="funding-history-main">
                <strong class="text-heading-s">{{ topUp.amount }} {{ config.asset }}</strong>
                <span
                  class="funding-history-status text-caption"
                  :class="{ 'funding-history-failed': topUp.state.kind === 'failed' }"
                >
                  {{ topUp.state.status }}
                </span>
              </span>
              <span class="funding-history-value">
                <strong
                  class="text-heading-s"
                  :class="
                    topUp.state.kind === 'settled'
                      ? 'funding-history-credit'
                      : 'funding-history-muted'
                  "
                >
                  {{ topUp.state.kind === "settled" ? `+${topUp.state.creditedAmount}` : "-" }}
                </strong>
                <span class="text-caption">{{ formatFundingHistoryWhen(topUp.state.at) }}</span>
              </span>
            </div>
          </li>
        </ul>
      </section>

      <p v-if="empty" class="funding-history-empty text-body-m">No top-ups yet.</p>
      <p v-if="error" class="funding-history-error text-caption" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.funding-history-screen {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}

.funding-history-header {
  display: flex;
  min-height: 3.75rem;
  flex: none;
  align-items: center;
  gap: 0.75rem;
  padding: 0 1.125rem;
}

.funding-history-header button {
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--fg-primary);
  transition: background-color 120ms ease-out;
}

.funding-history-header button:hover {
  background: var(--bg-selection-container-hover);
}

.funding-history-header h1 {
  color: var(--fg-primary);
}

.funding-history-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 1.125rem 1.25rem;
}

.funding-history-scroll h2 {
  color: var(--fg-tertiary);
  text-transform: uppercase;
}

.funding-history-earlier {
  margin-top: 1rem;
}

.funding-history-list {
  margin-top: 0.25rem;
}

.funding-history-list li + li {
  border-top: 1px solid var(--stroke-primary);
}

.funding-history-row {
  display: flex;
  width: 100%;
  min-height: 4.25rem;
  align-items: center;
  gap: 0.75rem;
  text-align: left;
}

button.funding-history-row {
  border-radius: var(--radius-small);
  transition: background-color 120ms ease-out;
}

button.funding-history-row:hover:not(:disabled) {
  background: var(--bg-surface-container);
}

.funding-history-main,
.funding-history-value {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.funding-history-main {
  flex: 1;
}

.funding-history-main strong,
.funding-history-value strong {
  overflow: hidden;
  color: var(--fg-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-history-status {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  margin-top: 0.1875rem;
  overflow: hidden;
  color: var(--fg-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-history-failed {
  color: var(--fg-error);
}

.funding-history-value {
  max-width: 7rem;
  flex: none;
  align-items: flex-end;
  text-align: right;
}

.funding-history-value span {
  margin-top: 0.1875rem;
  color: var(--fg-secondary);
  white-space: nowrap;
}

.funding-history-credit {
  color: var(--fg-success);
}

.funding-history-muted {
  color: var(--fg-secondary);
}

.funding-history-empty {
  padding-top: 2rem;
  color: var(--fg-secondary);
}

.funding-history-error {
  padding-top: 0.75rem;
  color: var(--fg-error);
  text-align: center;
}

@media (max-height: 650px) {
  .funding-history-header {
    min-height: 3.25rem;
  }
}
</style>
