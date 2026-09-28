<script setup lang="ts">
// The sheet a direct deposit raises when what arrived is not what was asked: the two figures side
// by side under their tokens, what the arrival converts to now, and the two ways on. Accept carries
// on with the new figure, recover leads to the funds return path. An overlay tap only asks the
// parent to close it.
import { computed } from "vue";
import { describeMismatch, type DepositMismatch } from "../../funding/deposit-mismatch";
import { cashAmount } from "../../utils/cash";
import { tokenIcon } from "../../utils/icons";
import BottomSheet from "../ui/BottomSheet.vue";
import CashAmount from "../ui/CashAmount.vue";
import PillButton from "../ui/PillButton.vue";

const props = defineProps<{ mismatch: DepositMismatch | null }>();
const emit = defineEmits<{ accept: []; recover: []; dismiss: [] }>();

const text = computed(() => (props.mismatch ? describeMismatch(props.mismatch) : null));

/** The asked figure and the landed one, each under its own token. */
const figures = computed(() => {
  const m = props.mismatch;
  if (!m) return [];
  return [
    { label: "Asked", ...m.asked },
    { label: "Arrived", ...m.landed },
  ];
});
</script>

<template>
  <BottomSheet :open="mismatch !== null" @dismiss="emit('dismiss')">
    <div v-if="mismatch && text" class="flex flex-col gap-6 p-6">
      <div class="flex flex-col gap-2">
        <h2 class="text-heading-xl text-fg-primary">{{ text.title }}</h2>
        <p class="text-body-m text-fg-secondary">{{ text.body }}</p>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div
          v-for="figure in figures"
          :key="figure.label"
          class="flex flex-col gap-2 rounded-nested bg-surface-nested p-3"
        >
          <span class="text-label-s text-fg-secondary">{{ figure.label }}</span>
          <span class="flex items-center gap-2">
            <img :src="tokenIcon(figure.symbol)" alt="" class="size-6 shrink-0 rounded-full" />
            <span class="truncate text-heading-m text-fg-primary">
              {{ figure.amount }} {{ figure.symbol }}
            </span>
          </span>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <span class="text-body-s text-fg-secondary">You'll get</span>
        <span class="text-display-s text-fg-primary"
          ><CashAmount :amount="mismatch.receive"
        /></span>
        <span class="text-body-m text-fg-secondary"
          >instead of {{ cashAmount(mismatch.target) }}</span
        >
      </div>

      <div class="flex flex-col gap-3">
        <PillButton @click="emit('accept')">{{ text.accept }}</PillButton>
        <PillButton variant="tertiary" @click="emit('recover')">Recover my funds</PillButton>
      </div>
    </div>
  </BottomSheet>
</template>
