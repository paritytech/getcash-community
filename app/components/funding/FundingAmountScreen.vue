<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Delete } from "lucide-vue-next";
import type { FundingSelectorConfig } from "../../funding/config";
import {
  fundingAmountStatus,
  reduceFundingAmount,
  type FundingKey,
  type FundingRoute,
} from "../../funding/selection";

const props = defineProps<{
  config: FundingSelectorConfig;
  amount: string;
  route: FundingRoute | null;
  /** Routes this build can run. Any other renders dimmed, marked "Soon", and unclickable. */
  availableRoutes?: readonly FundingRoute[];
  history: boolean;
  error?: string | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  change: [amount: string];
  route: [route: FundingRoute];
  continue: [];
  history: [];
}>();

const amountState = computed(() => fundingAmountStatus(props.amount, props.config.amount));
const isRouteAvailable = (candidate: FundingRoute) =>
  props.availableRoutes === undefined || props.availableRoutes.includes(candidate);
const canContinue = computed(
  () => amountState.value.kind === "valid" && props.route !== null && isRouteAvailable(props.route),
);
const limitWarning = computed(
  () => amountState.value.kind === "below-minimum" || amountState.value.kind === "above-maximum",
);
const keypad: readonly (readonly FundingKey[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  [".", "0", "delete"],
];

function formatAmount(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

const displayAmount = computed(() => (props.amount === "" ? "0" : formatAmount(props.amount)));

// The amount scales down with the asset label once its natural width would overflow the row. The
// scale is applied through a CSS variable.
const amountRow = ref<HTMLElement | null>(null);
const amountValue = ref<HTMLElement | null>(null);
const amountAsset = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;

function fitAmount() {
  const row = amountRow.value;
  const value = amountValue.value;
  const asset = amountAsset.value;
  if (!row || !value || !asset) return;

  row.style.setProperty("--amount-scale", "1");
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  const natural = value.getBoundingClientRect().width + asset.getBoundingClientRect().width;
  const available = row.clientWidth - gap;
  const scale = natural > 0 && available > 0 ? Math.min(1, available / natural) : 1;
  row.style.setProperty("--amount-scale", scale.toFixed(4));
}

watch(displayAmount, fitAmount, { flush: "post" });

onMounted(() => {
  fitAmount();
  if (typeof ResizeObserver !== "undefined" && amountRow.value) {
    resizeObserver = new ResizeObserver(fitAmount);
    resizeObserver.observe(amountRow.value);
  }
  // Web fonts change glyph widths once they load.
  document.fonts?.ready.then(fitAmount);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
const limitLabel = computed(() => {
  const limit =
    amountState.value.kind === "above-maximum"
      ? props.config.amount.maximum
      : props.config.amount.minimum;
  const boundary = amountState.value.kind === "above-maximum" ? "Maximum" : "Minimum";
  return `${boundary} ${formatAmount(limit)} ${props.config.asset}`;
});

function enter(key: FundingKey) {
  emit("change", reduceFundingAmount(props.amount, key, props.config.amount.decimals));
}
</script>

<template>
  <div class="funding-screen">
    <FundingEntryHeader title="Add funds" :history="history" @history="emit('history')" />

    <div class="funding-scroll">
      <div class="funding-amount-content">
        <div class="funding-routes" role="radiogroup" aria-label="Funding route">
          <button
            v-for="option in config.routes"
            :key="option.id"
            type="button"
            class="funding-route text-label-l"
            :class="{
              'funding-route-selected': route === option.id,
              'funding-route-unavailable': !isRouteAvailable(option.id),
            }"
            role="radio"
            :aria-checked="route === option.id"
            :disabled="!isRouteAvailable(option.id)"
            :aria-label="isRouteAvailable(option.id) ? undefined : `${option.label}, coming soon`"
            @click="emit('route', option.id)"
          >
            <img :src="option.icon" alt="" />
            <span>{{ option.label }}</span>
            <span v-if="!isRouteAvailable(option.id)" class="funding-route-soon text-overline"
              >Soon</span
            >
          </button>
        </div>

        <p class="funding-limits text-body-m" :class="{ 'funding-limits-warning': limitWarning }">
          {{ limitLabel }}
        </p>

        <div ref="amountRow" class="funding-amount" aria-live="polite">
          <span ref="amountValue" class="font-accent font-semibold">{{ displayAmount }}</span>
          <span ref="amountAsset" class="font-accent font-semibold">{{ config.asset }}</span>
        </div>

        <div class="funding-presets" aria-label="Suggested amounts">
          <button
            v-for="preset in config.amount.presets"
            :key="preset"
            type="button"
            class="text-label-l"
            @click="emit('change', preset)"
          >
            {{ formatAmount(preset) }} {{ config.asset }}
          </button>
        </div>

        <p v-if="error" class="funding-error text-caption" role="alert">{{ error }}</p>

        <div class="funding-keypad" aria-label="Amount keypad">
          <template v-for="(row, rowIndex) in keypad" :key="rowIndex">
            <button
              v-for="key in row"
              :key="key"
              type="button"
              class="font-mono text-heading-l font-medium"
              :aria-label="key === 'delete' ? 'Delete digit' : `Enter ${key}`"
              @click="enter(key)"
            >
              <Delete v-if="key === 'delete'" class="size-6" aria-hidden="true" />
              <span v-else>{{ key }}</span>
            </button>
          </template>
        </div>

        <button
          type="button"
          class="funding-primary text-label-l font-semibold"
          :disabled="loading || !canContinue"
          @click="emit('continue')"
        >
          {{ loading ? `Opening ${config.provider}…` : "Continue" }}
        </button>
      </div>
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

.funding-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.funding-amount-content {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  padding: 0.25rem 1.5rem 1rem;
  color: var(--fg-primary);
}

.funding-routes {
  display: flex;
  width: 100%;
  justify-content: center;
  gap: 0.5rem;
}

.funding-route {
  display: flex;
  min-width: 0;
  height: 2.875rem;
  align-items: center;
  gap: 0.375rem;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  padding: 0 0.75rem 0 0.375rem;
  color: var(--fg-primary);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.funding-route:hover:not(:disabled):not(.funding-route-selected) {
  background: var(--bg-selection-container-hover);
}

.funding-route-selected {
  background: var(--bg-action-primary);
  color: var(--fg-primary-inverted);
}

/* Routes not in this build: dimmed, greyscale, no pointer response. */
.funding-route-unavailable,
.funding-route-unavailable:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
  filter: grayscale(1);
}

.funding-route-soon {
  text-transform: uppercase;
  color: var(--fg-tertiary);
}

.funding-route img {
  width: 2rem;
  height: 2rem;
  flex: none;
}

.funding-amount {
  /* Fluid display type: the amount fits itself to the row, which the fixed
   * 14-step scale cannot express — reported as a gap. Sizes are pinned to the
   * scale's display stops (56px / 32px); face and weight come from the
   * font-accent font-semibold classes on the spans, matching text-display-*. */
  --amount-scale: 1;
  --amount-size: 3.5rem;
  --asset-size: 2rem;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: baseline;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 0.25rem;
  white-space: nowrap;
}

/* Both spans keep their natural width; fitAmount() shrinks the scale. Line heights stay fixed. */
.funding-amount > span {
  flex: none;
}

.funding-amount > span:first-child {
  font-size: calc(var(--amount-size) * var(--amount-scale));
  line-height: 5rem;
}

.funding-amount > span:last-child {
  font-size: calc(var(--asset-size) * var(--amount-scale));
  line-height: 3rem;
}

.funding-limits {
  min-height: 1rem;
  margin-top: 1.375rem;
  color: var(--fg-secondary);
  text-align: center;
}

.funding-limits-warning {
  color: var(--fg-error);
}

.funding-presets {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.funding-presets button {
  min-width: 0;
  height: 3.25rem;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  padding: 0 0.5rem;
  transition: background-color 120ms ease-out;
}

.funding-presets button:hover {
  background: var(--bg-selection-container-hover);
}

.funding-error {
  min-height: 1rem;
  margin-top: 0.5rem;
  color: var(--fg-error);
  text-align: center;
}

.funding-keypad {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.625rem 0.5rem;
  margin-top: auto;
  padding-top: 1rem;
}

.funding-keypad button {
  display: flex;
  height: 3.875rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  color: var(--fg-primary);
  transition: background-color 120ms ease-out;
}

.funding-keypad button:hover {
  background: var(--bg-selection-container-hover);
}

.funding-keypad button:active {
  background: var(--bg-selection-container-active);
}

.funding-primary {
  width: 100%;
  flex-shrink: 0;
  height: 3.375rem;
  margin-top: 1.25rem;
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

@media (max-height: 650px) {
  .funding-amount-content {
    padding-bottom: 0.75rem;
  }

  .funding-route {
    height: 2.5rem;
  }

  .funding-route img {
    width: 1.75rem;
    height: 1.75rem;
  }

  .funding-limits {
    margin-top: 0.75rem;
  }

  .funding-amount {
    /* Short-viewport adaptation of the fluid display gap noted above. */
    --amount-size: 3rem;
    --asset-size: 1.75rem;
  }

  .funding-amount > span:first-child {
    line-height: 3.75rem;
  }

  .funding-amount > span:last-child {
    line-height: 2.25rem;
  }

  .funding-presets {
    margin-top: 0.75rem;
  }

  .funding-presets button {
    height: 2.625rem;
  }

  .funding-keypad {
    gap: 0.375rem 0.5rem;
    padding-top: 0.625rem;
  }

  .funding-keypad button {
    height: 2.75rem;
  }

  .funding-primary {
    height: 3rem;
    margin-top: 0.625rem;
  }
}
</style>
