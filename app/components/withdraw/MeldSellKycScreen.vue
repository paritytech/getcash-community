<script setup lang="ts">
// The seller's KYC: the provider's page, edge to edge, where they verify themselves and name the
// account to be paid out to. The route reads the sale meanwhile and moves on once the provider
// names where the funds go. Cancel is offered until then, and never after.
import ScreenFrame from "../ui/ScreenFrame.vue";
import WidgetCancel from "../ui/WidgetCancel.vue";

defineProps<{
  widgetUrl: string;
  cancellable: boolean;
  cancelling: boolean;
  notice: string | null;
}>();
const emit = defineEmits<{ cancel: [] }>();
</script>

<template>
  <ScreenFrame class="w-full">
    <!-- `*` delegates the features down the provider's own nested frames, where the camera for
         the ID check and any payment sheet live; see `MeldPaySheet.vue`. -->
    <iframe
      :src="widgetUrl"
      class="min-h-0 w-full flex-1 border-0"
      title="Verify with the provider"
      allow="payment *; camera *; clipboard-write *"
    />
    <template v-if="cancellable || notice" #actions>
      <WidgetCancel
        :offered="cancellable"
        :cancelling="cancelling"
        :notice="notice"
        @cancel="emit('cancel')"
      />
    </template>
  </ScreenFrame>
</template>
