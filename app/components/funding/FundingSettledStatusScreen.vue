<script setup lang="ts">
import { computed } from "vue";
import type { FundingStatusDetail } from "../../funding/status";
import type { FundingTopUp } from "../../funding/top-ups";
import FundingDetailsDisclosure from "./FundingDetailsDisclosure.vue";
import FundingProgressDisclosure from "./progress/FundingProgressDisclosure.vue";

const props = defineProps<{ topUp: FundingTopUp }>();

const creditedAmount = computed(() =>
  props.topUp.state.kind === "settled"
    ? (props.topUp.state.creditedAmount ?? props.topUp.amount)
    : props.topUp.amount,
);

const details = computed<readonly FundingStatusDetail[]>(() => {
  const topUpDetails = props.topUp.details;
  const rows: FundingStatusDetail[] = [];
  if (topUpDetails?.token) {
    rows.push({
      key: "token",
      label: "Token",
      value: topUpDetails.token.label,
      icon: topUpDetails.token.icon,
    });
  }
  if (topUpDetails?.network) {
    rows.push({
      key: "network",
      label: "Network",
      value: topUpDetails.network.label,
      icon: topUpDetails.network.icon,
    });
  }
  if (topUpDetails?.method) {
    rows.push({
      key: "method",
      label: "Paid with",
      value: topUpDetails.method.label,
      icon: topUpDetails.method.icon,
    });
  }
  if (topUpDetails?.region) {
    rows.push({ key: "region", label: "Region", value: topUpDetails.region });
  }
  if (topUpDetails?.provider) {
    rows.push({
      key: "provider",
      label: "Provider",
      value: topUpDetails.provider.label,
      icon: topUpDetails.provider.icon,
    });
  }
  rows.push({
    key: "arrives",
    label: "Arrives",
    value: topUpDetails?.arrivalEstimate ?? "Completed",
    icon: "/icons/clock.svg",
  });
  rows.push({
    key: "receive",
    label: "You'll receive",
    value: `${creditedAmount.value} CASH`,
    icon: "/icons/arrow-down.svg",
  });
  if (topUpDetails?.depositAddress) {
    rows.push({
      key: "deposit-address",
      label: "Deposit address",
      value: topUpDetails.depositAddress,
      monospace: true,
    });
  }
  return rows;
});
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto pb-6">
    <div class="flex flex-col items-center text-center">
      <span class="flex size-14 items-center justify-center rounded-full bg-surface-container">
        <img src="/icons/plus.svg" alt="" class="size-6" />
      </span>
      <p class="mt-4 text-base leading-5 text-text-secondary">Added</p>
      <p class="mt-3 text-[56px] leading-[64px] font-semibold text-success">
        +{{ creditedAmount }} CASH
      </p>
      <p class="text-base leading-5 text-text-secondary">To your balance</p>
    </div>

    <div class="mt-6 flex flex-col gap-3">
      <FundingProgressDisclosure :progress="topUp.progress" />
      <FundingDetailsDisclosure :rows="details" />
    </div>
  </div>
</template>
