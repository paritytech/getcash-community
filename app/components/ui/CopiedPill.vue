<script setup lang="ts">
// The "Copied" confirmation, in the one place every screen draws it.
//
// Driven by the shared copy signal rather than a prop: a screen can hold several independent
// copy controls (the refund guide has three), and threading each one's flag up to a single pill
// means every new control has to remember to join in. Watching the signal, any successful copy
// anywhere raises it, and a screen opts in simply by rendering this.
import { onUnmounted, ref, watch } from "vue";
import { copiedAt } from "../../composables/useCopyToClipboard";
import SnackBar from "./SnackBar.vue";

const props = withDefaults(defineProps<{ durationMs?: number }>(), { durationMs: 2000 });

const show = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(copiedAt, (at) => {
  if (at === 0) return; // nothing copied yet this session
  show.value = true;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => (show.value = false), props.durationMs);
});

onUnmounted(() => {
  if (timer !== null) clearTimeout(timer);
});
</script>

<template>
  <div v-if="show" class="flex shrink-0 justify-center pb-3" aria-live="polite">
    <SnackBar text="Copied" tone="success" />
  </div>
</template>
