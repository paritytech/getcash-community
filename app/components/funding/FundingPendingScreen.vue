<script setup lang="ts">
// The shell's landing screen while a top-up is running: the cards, a collapse once the list grows
// past a screenful, and the way to start another one.
import { computed, ref } from "vue";
import { ChevronDown, ChevronUp } from "lucide-vue-next";
import type { FundingSelectorConfig } from "../../funding/config";
import type { InProgressFundingTopUp, SettledFundingTopUp } from "../../funding/top-ups";
import PillButton from "../ui/PillButton.vue";
import FundingTopUpProgressCard from "./FundingTopUpProgressCard.vue";

type PendingTopUp = InProgressFundingTopUp | SettledFundingTopUp;

/** How many cards the list shows before the collapse. Three is what the design's loading frame
 *  lays out, and it is the most that clears the New top-up button on a short webview. */
const COLLAPSED_CARDS = 3;

const props = withDefaults(
  defineProps<{
    config: FundingSelectorConfig;
    topUps?: readonly InProgressFundingTopUp[];
    latestTopUp?: SettledFundingTopUp | null;
    openingTopUpId?: string | null;
    error?: string | null;
    /** Launch-load placeholder: the screen's own shapes instead of the list. */
    skeleton?: boolean;
  }>(),
  {
    topUps: () => [],
    latestTopUp: null,
    openingTopUpId: null,
    error: null,
    skeleton: false,
  },
);

const emit = defineEmits<{
  history: [];
  newTopUp: [];
  open: [topUp: PendingTopUp];
}>();

// The settled card rides at the end of the same list: the design gives it a state on the card,
// not a section of its own.
const cards = computed<readonly PendingTopUp[]>(() =>
  props.latestTopUp === null ? props.topUps : [...props.topUps, props.latestTopUp],
);
const expanded = ref(false);
const collapsible = computed(() => cards.value.length > COLLAPSED_CARDS);
const visible = computed(() =>
  collapsible.value && !expanded.value ? cards.value.slice(0, COLLAPSED_CARDS) : cards.value,
);
const busy = computed(() => Boolean(props.openingTopUpId));
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <FundingEntryHeader
      :title="skeleton ? '' : 'Top-up in progress'"
      history
      :skeleton="skeleton"
      @history="emit('history')"
    />

    <!-- The screen's own shapes while the top-ups are still being read. -->
    <div
      v-if="skeleton"
      class="flex min-h-0 flex-1 flex-col px-4 pt-4 pb-6"
      aria-label="Loading your top-ups"
    >
      <div class="flex flex-col gap-2">
        <span
          v-for="n in COLLAPSED_CARDS"
          :key="n"
          class="funding-pending-shape h-[4.75rem] animate-pulse bg-action-disabled"
        />
        <span class="funding-pending-shape mx-auto h-8 w-28 animate-pulse bg-action-disabled" />
      </div>
      <span class="funding-pending-shape mt-auto h-12 animate-pulse bg-action-disabled" />
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col px-4 pt-4 pb-6">
      <div class="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
        <ul class="flex flex-col gap-2">
          <li v-for="topUp in visible" :key="topUp.id">
            <FundingTopUpProgressCard
              :top-up="topUp"
              :asset="config.asset"
              :opening="openingTopUpId === topUp.id"
              :disabled="busy"
              @open="emit('open', topUp)"
            />
          </li>
        </ul>

        <!-- The collapse keeps the button reachable when the list outgrows the screen. -->
        <div v-if="collapsible" class="mt-2 flex justify-center">
          <button
            type="button"
            class="flex h-8 items-center gap-1 rounded-full bg-surface-container px-3 text-body-m text-fg-primary transition-colors hover:bg-selection-container-hover"
            @click="expanded = !expanded"
          >
            <span>{{ expanded ? "Show less" : "Show more" }}</span>
            <component
              :is="expanded ? ChevronUp : ChevronDown"
              class="size-3 shrink-0"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <p v-if="error" class="mt-3 text-center text-caption text-fg-error" role="alert">
        {{ error }}
      </p>

      <PillButton class="mt-6 w-full" :disabled="busy" @click="emit('newTopUp')">
        New top-up
      </PillButton>
    </div>
  </div>
</template>

<style scoped>
/* 24px; the radius scale has no semantic step this size. */
.funding-pending-shape {
  display: block;
  flex: none;
  border-radius: var(--scale-radius-large);
}
</style>
