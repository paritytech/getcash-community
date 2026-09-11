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
          <h2 class="text-overline">In progress</h2>
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
          <h2 class="text-overline">Your latest top-up</h2>
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

      <p v-if="error" class="funding-pending-error text-caption" role="alert">{{ error }}</p>

      <button
        type="button"
        class="funding-primary text-label-l font-semibold"
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
  color: var(--fg-tertiary);
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
  color: var(--fg-error);
  text-align: center;
}

.funding-primary {
  height: 3.375rem;
  flex: none;
  margin-top: auto;
  border-radius: 9999px;
  background: var(--bg-action-primary);
  color: var(--fg-primary-inverted);
  transition: background-color 120ms ease-out;
}

.funding-primary:hover:not(:disabled) {
  background: var(--bg-action-primary-hover);
}

.funding-primary:disabled {
  background: var(--bg-action-disabled);
  color: var(--fg-disabled);
}
</style>
