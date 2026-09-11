<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
  const { minimum, maximum } = props.config.amount;
  const asset = props.config.asset;
  if (amountState.value.kind === "below-minimum")
    return `Minimum ${formatAmount(minimum)} ${asset}`;
  if (amountState.value.kind === "above-maximum")
    return `Maximum ${formatAmount(maximum)} ${asset}`;
  return `${formatAmount(minimum)} to ${formatAmount(maximum)} ${asset}`;
});

function enter(key: FundingKey) {
  emit("change", reduceFundingAmount(props.amount, key, props.config.amount.decimals));
}
</script>

<template>
  <div class="funding-screen">
    <FundingEntryHeader title="Top up funds" :history="history" @history="emit('history')" />

    <div class="funding-scroll">
      <div class="funding-amount-content">
        <div class="funding-routes" role="radiogroup" aria-label="Funding route">
          <button
            v-for="option in config.routes"
            :key="option.id"
            type="button"
            class="funding-route"
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
            <span v-if="!isRouteAvailable(option.id)" class="funding-route-soon">Soon</span>
          </button>
        </div>

        <p
          class="funding-limits"
          :class="{ 'funding-limits-warning': limitWarning }"
          aria-live="polite"
        >
          {{ limitLabel }}
        </p>

        <div ref="amountRow" class="funding-amount" aria-live="polite">
          <span ref="amountValue">{{ displayAmount }}</span>
          <span ref="amountAsset">{{ config.asset }}</span>
        </div>

        <div class="funding-presets" aria-label="Suggested amounts">
          <button
            v-for="preset in config.amount.presets"
            :key="preset"
            type="button"
            @click="emit('change', preset)"
          >
            {{ formatAmount(preset) }} {{ config.asset }}
          </button>
        </div>

        <p v-if="error" class="funding-error" role="alert">{{ error }}</p>

        <div class="funding-keypad" aria-label="Amount keypad">
          <template v-for="(row, rowIndex) in keypad" :key="rowIndex">
            <button
              v-for="key in row"
              :key="key"
              type="button"
              :aria-label="key === 'delete' ? 'Delete digit' : `Enter ${key}`"
              @click="enter(key)"
            >
              <svg v-if="key === 'delete'" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9.5 7 5 12l4.5 5H19V7H9.5Z" />
                <path d="m12 10 4 4m0-4-4 4" />
              </svg>
              <span v-else>{{ key }}</span>
            </button>
          </template>
        </div>

        <button
          type="button"
          class="funding-primary"
          :disabled="loading || !canContinue"
          @click="emit('continue')"
        >
          {{ loading ? `Opening ${config.provider}…` : "Continue to top up" }}
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
  background: var(--funding-control);
  padding: 0 0.75rem 0 0.375rem;
  color: var(--funding-text);
  font-size: 0.9375rem;
  line-height: 1.25rem;
  font-weight: 600;
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.funding-route-selected {
  background: var(--funding-action);
  color: var(--funding-action-text);
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
  font-size: 0.6875rem;
  line-height: 1rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--funding-text-muted);
}

.funding-route img {
  width: 2rem;
  height: 2rem;
  flex: none;
}

.funding-amount {
  --amount-scale: 1;
  --amount-size: 4rem;
  --asset-size: 2.25rem;
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
  font-weight: 500;
}

.funding-amount > span:first-child {
  font-size: calc(var(--amount-size) * var(--amount-scale));
  line-height: 5rem;
  letter-spacing: -0.04em;
}

.funding-amount > span:last-child {
  font-size: calc(var(--asset-size) * var(--amount-scale));
  line-height: 3rem;
  letter-spacing: -0.015em;
}

.funding-limits {
  min-height: 1rem;
  margin-top: 1.375rem;
  color: var(--funding-text-muted);
  font-size: 0.875rem;
  line-height: 1.25rem;
  text-align: center;
  transition: color 150ms ease;
}

.funding-limits-warning {
  color: var(--funding-error);
  font-weight: 500;
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
  background: var(--funding-control);
  padding: 0 0.5rem;
  font-size: 0.9375rem;
  line-height: 1.25rem;
  font-weight: 600;
}

.funding-error {
  min-height: 1rem;
  margin-top: 0.5rem;
  color: var(--funding-error);
  font-size: 0.75rem;
  line-height: 1rem;
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
  background: var(--funding-control);
  font-size: 1.5rem;
  line-height: 2rem;
  font-weight: 500;
}

.funding-keypad svg {
  width: 1.5rem;
  height: 1.5rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.75;
}

.funding-primary {
  width: 100%;
  flex-shrink: 0;
  height: 3.375rem;
  margin-top: 1.25rem;
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
