<script setup lang="ts">
// The transfer details of a headless bank order, each one copyable, where the provider's page
// would be. Polls the Meld status from the moment they are shown, as that page does.
import { computed, onMounted } from "vue";
import type { BankInstructions } from "@getsome/meld";
import { bankDetailRows, bankDetailsLead } from "../../../funding/meld-bank-details";
import { useSessionStore } from "../../../stores/session";
import DetailRows from "../../ui/DetailRows.vue";

const props = defineProps<{ instructions: BankInstructions }>();

const session = useSessionStore();

const lead = computed(() => bankDetailsLead(props.instructions));
const rows = computed(() => bankDetailRows(props.instructions));

onMounted(() => session.pollMeldStatus());
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
    <p class="text-body-m text-fg-secondary">{{ lead }}</p>
    <DetailRows :rows="rows" />
  </div>
</template>
