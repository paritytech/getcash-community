<script setup lang="ts">
// Every top-up the shell knows about, on the same cards the top-up screen uses: the running ones
// first, then what they came to — a credit or a failure.
import { computed } from "vue";
import { History } from "lucide-vue-next";
import type { FundingSelectorConfig } from "../../funding/config";
import type { InProgressFundingTopUp, PastFundingTopUp } from "../../funding/top-ups";
import FundingTopUpProgressCard from "./FundingTopUpProgressCard.vue";

/** How many card shapes the placeholder lays out; the design draws a screenful. */
const SKELETON_CARDS = 4;

const props = withDefaults(
  defineProps<{
    config: FundingSelectorConfig;
    inProgress?: readonly InProgressFundingTopUp[];
    past?: readonly PastFundingTopUp[];
    openingTopUpId?: string | null;
    error?: string | null;
    /** Load placeholder: the list's own shapes, under the real toolbar. */
    skeleton?: boolean;
  }>(),
  {
    inProgress: () => [],
    past: () => [],
    openingTopUpId: null,
    error: null,
    skeleton: false,
  },
);

const emit = defineEmits<{
  back: [];
  open: [topUp: InProgressFundingTopUp | PastFundingTopUp];
}>();

const empty = computed(() => props.inProgress.length === 0 && props.past.length === 0);
const busy = computed(() => Boolean(props.openingTopUpId));
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- The toolbar is real even while the list loads: the way back must never be a placeholder. -->
    <FundingEntryHeader title="History" back centered @back="emit('back')" />

    <div
      v-if="skeleton"
      class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-4 pt-6 pb-6"
      aria-label="Loading your top-ups"
    >
      <span class="funding-history-shape h-4 w-26 animate-pulse bg-action-disabled" />
      <span
        v-for="n in SKELETON_CARDS"
        :key="n"
        class="funding-history-shape h-[4.75rem] animate-pulse bg-action-disabled"
      />
    </div>

    <!-- Nothing has ever been topped up: the clock the list lives behind, and why it is bare. -->
    <div
      v-else-if="empty"
      class="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-6 text-center"
    >
      <History class="size-7 text-fg-secondary" aria-hidden="true" />
      <p class="mt-2 max-w-[19.5rem] text-body-m text-fg-secondary">
        Nothing here yet. Your top-ups will appear as you make them.
      </p>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col px-4 pt-6 pb-6">
      <div class="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
        <section v-if="inProgress.length > 0">
          <h2 class="text-heading-l text-fg-primary">In progress</h2>
          <ul class="mt-4 flex flex-col gap-2">
            <li v-for="topUp in inProgress" :key="topUp.id">
              <FundingTopUpProgressCard
                :top-up="topUp"
                :asset="config.asset"
                :opening="openingTopUpId === topUp.id"
                :disabled="busy"
                @open="emit('open', topUp)"
              />
            </li>
          </ul>
        </section>

        <!-- A finished top-up opens its journey too: what it cost, and for a refunded one the
             way to the recovery guide. -->
        <section v-if="past.length > 0" :class="{ 'mt-8': inProgress.length > 0 }">
          <h2 class="text-heading-l text-fg-primary">Completed</h2>
          <ul class="mt-4 flex flex-col gap-2">
            <li v-for="topUp in past" :key="topUp.id">
              <FundingTopUpProgressCard
                :top-up="topUp"
                :asset="config.asset"
                :opening="openingTopUpId === topUp.id"
                :disabled="busy"
                @open="emit('open', topUp)"
              />
            </li>
          </ul>
        </section>

        <p v-if="error" class="pt-3 text-center text-caption text-fg-error" role="alert">
          {{ error }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.funding-history-shape {
  display: block;
  flex: none;
  border-radius: var(--scale-radius-large);
}
</style>
