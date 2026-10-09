<script setup lang="ts">
// The identity step a Meld order waits on: the form for a new customer, the hosted check, and the
// wait for its answer. Emits `ready` once the customer is approved. The host route owns the toolbar:
// it lays the step out edge to edge while `fullBleed`, and offers its Back to `back()` first.
import { computed, watch } from "vue";
import { useMeldIdentityStep } from "../../../composables/useMeldIdentityStep";
import PillButton from "../../ui/PillButton.vue";
import MeldIdentityScreen from "./MeldIdentityScreen.vue";
import MeldKycSheet from "./MeldKycSheet.vue";

defineProps<{
  /** The payment country, registered as the buyer's home country. */
  country: string;
}>();
const emit = defineEmits<{ ready: []; back: [] }>();

const step = useMeldIdentityStep();
const { stage, kycUrl, busy, error, register, retry } = step;

watch(
  step.approved,
  (approved) => {
    if (approved) emit("ready");
  },
  { immediate: true },
);

/** Whether the hosted check is up, which needs the whole width. */
const fullBleed = computed(() => stage.value === "kyc");

/** Handles the route's Back inside the step: leaving the hosted check waits for its answer.
 *  False when the route should leave instead. */
function back(): boolean {
  if (stage.value !== "kyc") return false;
  void step.leaveKyc();
  return true;
}

defineExpose({ fullBleed, back });
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <MeldIdentityScreen
      v-if="stage === 'form'"
      :country="country"
      :busy="busy"
      :error="error"
      @submit="register"
    />
    <MeldKycSheet
      v-else-if="
        stage === 'kyc' || stage === 'checking' || stage === 'rejected' || stage === 'expired'
      "
      :stage="stage"
      :url="kycUrl"
      @retry="retry"
      @back="emit('back')"
    />
    <template v-else-if="stage === 'error'">
      <div class="flex min-h-0 w-full flex-1 flex-col items-center justify-center text-center">
        <p class="max-w-[260px] text-body-m text-fg-secondary" role="alert">
          {{ error ?? "Couldn't reach the payment service. Please try again." }}
        </p>
      </div>
      <PillButton variant="secondary" class="mb-6 w-full" @click="retry">Retry</PillButton>
    </template>
    <div v-else-if="stage === 'loading'" class="flex justify-center pt-16">
      <span
        class="inline-block size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
      />
    </div>
  </div>
</template>
