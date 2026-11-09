<script setup lang="ts">
import { computed } from "vue";
import { splitCashText } from "../../utils/cash";
import CashAmount from "./CashAmount.vue";
import CashLogo from "./CashLogo.vue";

const props = defineProps<{ text: string }>();

const parts = computed(() => splitCashText(props.text));
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <CashAmount v-if="part.kind === 'lockup'" :sign="part.sign" :amount="part.amount" />
    <CashLogo v-else-if="part.kind === 'word'" variant="word" />
    <template v-else>{{ part.text }}</template>
  </template>
</template>
