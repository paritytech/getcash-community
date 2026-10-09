<script setup lang="ts">
// Meld's hosted identity check, edge to edge like the payment widget, and what follows it: the
// wait for its answer, from which an unfinished check can be continued, or a rejected or expired
// check the buyer can start again.
import { CircleX, Clock } from "lucide-vue-next";
import PillButton from "../../ui/PillButton.vue";

defineProps<{
  stage: "kyc" | "checking" | "rejected" | "expired";
  /** The hosted check, while it is open. */
  url?: string | null;
}>();
const emit = defineEmits<{ retry: []; back: [] }>();
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <!-- `*` for the same reason as the payment widget: the check may nest its capture page in a
         further frame, and the camera has to reach it there. -->
    <iframe
      v-if="stage === 'kyc' && url"
      :src="url"
      class="min-h-0 w-full flex-1 border-0"
      title="Identity check"
      allow="camera *"
    />
    <p v-else-if="stage === 'kyc'" class="flex-1 py-8 text-center text-body-m text-fg-tertiary">
      Preparing identity check…
    </p>
    <template v-else-if="stage === 'checking'">
      <div
        class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
      >
        <span
          class="mb-2 size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
        />
        <p class="text-label-l font-semibold text-fg-primary">Checking your identity</p>
        <p class="max-w-[260px] text-body-m text-fg-secondary">
          This usually takes a few minutes. You can leave this screen. We continue when the check is
          done.
        </p>
      </div>
      <PillButton class="mb-3 w-full" @click="emit('retry')">Continue the check</PillButton>
      <PillButton variant="secondary" class="mb-6 w-full" @click="emit('back')">
        Back to top-ups
      </PillButton>
    </template>
    <template v-else>
      <div
        class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
      >
        <CircleX v-if="stage === 'rejected'" class="size-8 text-fg-error" aria-hidden="true" />
        <Clock v-else class="size-8 text-fg-primary" aria-hidden="true" />
        <p class="text-label-l font-semibold text-fg-primary">
          {{ stage === "rejected" ? "Identity check not approved" : "Identity check expired" }}
        </p>
        <p class="max-w-[260px] text-body-m text-fg-secondary">
          {{
            stage === "rejected"
              ? "Meld could not confirm your identity from what was sent. You can start the check again."
              : "The check was not finished in time. Start it again to continue."
          }}
        </p>
      </div>
      <PillButton class="mb-6 w-full" @click="emit('retry')">
        {{ stage === "rejected" ? "Try again" : "Start again" }}
      </PillButton>
    </template>
  </div>
</template>
