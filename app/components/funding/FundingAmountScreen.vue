<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Delete } from "lucide-vue-next";
import type { FundingSelectorConfig } from "../../funding/config";
import SkeletonBlock from "../ui/SkeletonBlock.vue";
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
  /** Launch-load placeholder: static chrome (amount, keypad) renders inert while the data-driven
   *  parts (title, route pills, limits, presets, CTA label) show skeleton shapes. */
  skeleton?: boolean;
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
    <FundingEntryHeader
      title="Add funds"
      :history="history"
      :skeleton="skeleton"
      @history="emit('history')"
    />

    <div class="funding-scroll">
      <div class="funding-amount-content" :class="{ 'funding-amount-skeleton': skeleton }">
        <div v-if="skeleton" class="funding-routes" aria-hidden="true">
          <SkeletonBlock
            v-for="option in config.routes"
            :key="option.id"
            style="width: 5.75rem; height: 2.5rem"
          />
        </div>
        <div v-else class="funding-routes" role="radiogroup" aria-label="Funding route">
          <button
            v-for="option in config.routes"
            :key="option.id"
            type="button"
            class="funding-route text-label-l font-semibold"
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

        <div ref="amountRow" class="funding-amount" aria-live="polite">
          <span ref="amountValue" class="text-display-xl"
            >{{ displayAmount }}<span v-if="!skeleton" class="funding-caret" aria-hidden="true"
          /></span>
          <span ref="amountAsset" class="text-display-xl">{{ config.asset }}</span>
        </div>

        <SkeletonBlock v-if="skeleton" style="width: 8.125rem; height: 1rem" />
        <p
          v-else
          class="funding-limits text-body-m"
          :class="{ 'funding-limits-warning': limitWarning }"
        >
          {{ limitLabel }}
        </p>

        <div v-if="skeleton" class="funding-presets" aria-hidden="true">
          <SkeletonBlock
            v-for="preset in config.amount.presets"
            :key="preset"
            style="height: 3rem"
          />
        </div>
        <div v-else class="funding-presets" aria-label="Suggested amounts">
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
              class="text-heading-xl"
              :disabled="skeleton"
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
          :disabled="skeleton || loading || !canContinue"
          @click="emit('continue')"
        >
          {{ skeleton ? "" : loading ? `Opening ${config.provider}…` : "Continue" }}
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
  padding: 1rem 1rem 1rem;
  color: var(--fg-primary);
}

.funding-routes {
  display: flex;
  width: 100%;
  justify-content: center;
  gap: 0.5rem;
}

/* The launch skeleton keeps the static chrome but mutes it and drops interaction. */
.funding-amount-skeleton .funding-keypad button {
  color: var(--fg-secondary);
  pointer-events: none;
}

.funding-route {
  display: flex;
  min-width: 0;
  height: 2.5rem;
  align-items: center;
  gap: 0.5rem;
  border-radius: 9999px;
  background: var(--bg-surface-container);
  padding: 0 0.75rem 0 0.5rem;
  color: var(--fg-primary);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.funding-route:hover:not(:disabled):not(.funding-route-selected) {
  background: var(--bg-selection-container-hover);
}

.funding-route-selected {
  background: var(--bg-surface-container-inverted);
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
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  border-radius: 9999px;
}

.funding-amount {
  /* Fluid display type: the amount fits itself to the row, which the fixed
   * type scale cannot express. The spans carry text-display-xl; the only
   * scoped override is the fluid font-size, which re-states the same 56px
   * stop times the fit scale. */
  --amount-scale: 1;
  --amount-size: 3.5rem;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: baseline;
  justify-content: center;
  gap: 1rem;
  margin-top: 1.5rem;
  white-space: nowrap;
}

/* Both spans keep their natural width; fitAmount() shrinks the scale. Line heights stay fixed. */
.funding-amount > span {
  flex: none;
  font-size: calc(var(--amount-size) * var(--amount-scale));
  /* 80/56 as a unitless ratio keeps the same leading at every fluid scale
     (the token's line-height is a fixed 80px). */
  line-height: 1.4286;
}

/* Text-cursor caret after the digits: the keypad is live input. Sized in em so
   it follows the fluid scale; sits inside the digits span so the fit logic
   measures it. currentColor keeps it on fg-primary. */
.funding-caret {
  display: inline-block;
  width: 0.036em;
  height: 1em;
  border-radius: 9999px;
  background: currentColor;
  vertical-align: -0.11em;
  animation: funding-caret-blink 1.1s step-end infinite;
}

@keyframes funding-caret-blink {
  0%,
  49% {
    opacity: 1;
  }

  50%,
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .funding-caret {
    animation: none;
  }
}

.funding-limits {
  min-height: 1rem;
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
  margin-top: 1.5rem;
  padding: 0 0.5rem;
}

.funding-presets button {
  min-width: 0;
  height: 3rem;
  border-radius: 9999px;
  background: var(--bg-surface-nested);
  padding: 0 1rem;
  overflow: hidden;
  white-space: nowrap;
  transition: background-color 120ms ease-out;
}

.funding-presets button:hover {
  background: var(--bg-selection-container-hover);
}

/* The error renders inside the fixed 24px presets→keypad band (8px margin +
   16px line − 24px pull-back), so showing it never shifts the keypad. */
.funding-error {
  min-height: 1rem;
  margin-top: 0.5rem;
  margin-bottom: -1.5rem;
  color: var(--fg-error);
  text-align: center;
}

/* The keypad follows the content; the flexible space lives below it, on the
   Continue button, so the CTA stays anchored to the bottom edge. The
   margin-bottom keeps a minimum gap to the CTA when the screen is tight and
   the auto margin collapses. */
.funding-keypad {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 1.5rem;
  margin-bottom: 1.5rem;
}

.funding-keypad button {
  display: flex;
  height: 3.5rem;
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

/* The pressed ring is an inset shadow so pressing never shifts the glyph. */
.funding-keypad button:active {
  background: var(--bg-surface-main);
  box-shadow: inset 0 0 0 1px var(--stroke-primary);
}

.funding-primary {
  width: 100%;
  flex-shrink: 0;
  height: 3rem;
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

@media (max-height: 650px) {
  .funding-amount-content {
    padding-bottom: 0.75rem;
  }

  .funding-amount {
    /* Short-viewport adaptation of the fluid display gap noted above. */
    --amount-size: 3rem;
    margin-top: 0.75rem;
  }

  .funding-presets {
    margin-top: 0.75rem;
  }

  .funding-presets button {
    height: 2.625rem;
  }

  .funding-keypad {
    gap: 0.375rem 0.5rem;
    margin-bottom: 0.625rem;
  }

  .funding-keypad button {
    height: 2.75rem;
  }
}
</style>
