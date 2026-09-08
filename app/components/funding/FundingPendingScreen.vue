<script setup lang="ts">
import type { FundingSelectorConfig } from "../../funding/config";
import type { InProgressFundingTopUp, SettledFundingTopUp } from "../../funding/top-ups";
import FundingTopUpProgressCard from "./FundingTopUpProgressCard.vue";

type PendingTopUp = InProgressFundingTopUp | SettledFundingTopUp;

defineProps<{
  config: FundingSelectorConfig;
  topUps: readonly InProgressFundingTopUp[];
  latestTopUp?: SettledFundingTopUp | null;
  openingTopUpId?: string | null;
  error?: string | null;
}>();

const emit = defineEmits<{
  history: [];
  newTopUp: [];
  open: [topUp: PendingTopUp];
}>();
</script>

<template>
  <div class="funding-screen">
    <FundingEntryHeader title="Top-ups" history @history="emit('history')" />

    <div class="funding-pending-content">
      <div class="funding-pending-scroll">
        <section v-if="topUps.length > 0">
          <h2>In progress</h2>
          <ul class="funding-pending-list">
            <li v-for="topUp in topUps" :key="topUp.id">
              <FundingTopUpProgressCard
                :top-up="topUp"
                :asset="config.asset"
                :opening="openingTopUpId === topUp.id"
                :disabled="openingTopUpId !== null && openingTopUpId !== undefined"
                @open="emit('open', $event)"
              />
            </li>
          </ul>
        </section>

        <section v-if="latestTopUp" :class="{ 'funding-pending-latest-spaced': topUps.length > 0 }">
          <h2>Your latest top-up</h2>
          <FundingTopUpProgressCard
            class="funding-pending-latest-card"
            :top-up="latestTopUp"
            :asset="config.asset"
            :opening="openingTopUpId === latestTopUp.id"
            :disabled="openingTopUpId !== null && openingTopUpId !== undefined"
            @open="emit('open', $event)"
          />
        </section>
      </div>

      <p v-if="error" class="funding-pending-error" role="alert">{{ error }}</p>

      <button
        type="button"
        class="funding-primary"
        :disabled="Boolean(openingTopUpId)"
        @click="emit('newTopUp')"
      >
        New top-up
      </button>
    </div>
  </div>
</template>

<style scoped>
.funding-screen {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}

.funding-pending-content {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.5rem 1.125rem 0.75rem;
}

.funding-pending-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}

.funding-pending-list {
  display: flex;
  margin-top: 0.375rem;
  flex-direction: column;
  gap: 0.75rem;
}

.funding-pending-scroll h2 {
  color: var(--funding-text-muted);
  font-size: 0.6875rem;
  line-height: 0.9375rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.funding-pending-latest-spaced {
  margin-top: 1.25rem;
}

.funding-pending-latest-card {
  margin-top: 0.375rem;
}

.funding-pending-error {
  margin-top: 0.75rem;
  color: var(--funding-error);
  font-size: 0.75rem;
  line-height: 1rem;
  text-align: center;
}

.funding-primary {
  height: 3.375rem;
  flex: none;
  margin-top: auto;
  border-radius: 9999px;
  background: var(--funding-action);
  color: var(--funding-action-text);
  font-size: 0.9375rem;
  line-height: 1.25rem;
  font-weight: 650;
}

.funding-primary:disabled {
  opacity: 0.4;
}
</style>
