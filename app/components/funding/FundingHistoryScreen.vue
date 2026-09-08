<script setup lang="ts">
import { computed } from "vue";
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
        <img src="/icons/chevron-left.svg" alt="" />
      </button>
      <h1>History</h1>
    </header>

    <div class="funding-history-scroll">
      <section v-if="inProgress.length > 0">
        <h2>In progress</h2>
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
                <strong>{{ topUp.amount }} {{ config.asset }}</strong>
                <span class="funding-history-status">
                  {{ openingTopUpId === topUp.id ? "Opening…" : topUp.progress.view.label }}
                </span>
              </span>
              <span class="funding-history-value">
                <strong>{{ topUp.amount }}</strong>
                <span>{{ formatFundingHistoryWhen(topUp.startedAt) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="past.length > 0" :class="{ 'funding-history-earlier': inProgress.length > 0 }">
        <h2>Earlier</h2>
        <ul class="funding-history-list">
          <li v-for="topUp in past" :key="topUp.id">
            <div class="funding-history-row">
              <FundingProgressRing :progress="topUp.progress" />
              <span class="funding-history-main">
                <strong>{{ topUp.amount }} {{ config.asset }}</strong>
                <span
                  class="funding-history-status"
                  :class="{ 'funding-history-failed': topUp.state.kind === 'failed' }"
                >
                  {{ topUp.state.status }}
                </span>
              </span>
              <span class="funding-history-value">
                <strong
                  :class="
                    topUp.state.kind === 'settled'
                      ? 'funding-history-credit'
                      : 'funding-history-muted'
                  "
                >
                  {{ topUp.state.kind === "settled" ? `+${topUp.state.creditedAmount}` : "-" }}
                </strong>
                <span>{{ formatFundingHistoryWhen(topUp.state.at) }}</span>
              </span>
            </div>
          </li>
        </ul>
      </section>

      <p v-if="empty" class="funding-history-empty">No top-ups yet.</p>
      <p v-if="error" class="funding-history-error" role="alert">{{ error }}</p>
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
  background: var(--funding-control);
}

.funding-history-header button img {
  width: 1.5rem;
  height: 1.5rem;
}

.funding-history-header h1 {
  font-size: 1.125rem;
  line-height: 1.375rem;
  font-weight: 650;
}

.funding-history-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 1.125rem 1.25rem;
}

.funding-history-scroll h2 {
  color: var(--funding-text-muted);
  font-size: 0.6875rem;
  line-height: 0.9375rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.funding-history-earlier {
  margin-top: 1rem;
}

.funding-history-list {
  margin-top: 0.25rem;
}

.funding-history-list li + li {
  border-top: 1px solid color-mix(in srgb, var(--funding-border) 35%, transparent);
}

.funding-history-row {
  display: flex;
  width: 100%;
  min-height: 4.25rem;
  align-items: center;
  gap: 0.75rem;
  text-align: left;
}

button.funding-history-row:disabled {
  cursor: default;
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
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-history-status {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  margin-top: 0.1875rem;
  overflow: hidden;
  color: var(--funding-text-muted);
  font-size: 0.75rem;
  line-height: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-history-failed {
  color: var(--funding-error);
}

.funding-history-value {
  max-width: 7rem;
  flex: none;
  align-items: flex-end;
  text-align: right;
}

.funding-history-value span {
  margin-top: 0.1875rem;
  color: var(--funding-text-muted);
  font-size: 0.75rem;
  line-height: 1rem;
  white-space: nowrap;
}

.funding-history-credit {
  color: var(--funding-success);
}

.funding-history-muted {
  color: var(--funding-text-muted);
}

.funding-history-empty {
  padding-top: 2rem;
  color: var(--funding-text-muted);
  font-size: 0.875rem;
  line-height: 1.25rem;
}

.funding-history-error {
  padding-top: 0.75rem;
  color: var(--funding-error);
  font-size: 0.75rem;
  line-height: 1rem;
  text-align: center;
}

@media (max-height: 650px) {
  .funding-history-header {
    min-height: 3.25rem;
  }
}
</style>
