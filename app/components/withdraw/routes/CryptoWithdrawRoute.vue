<script setup lang="ts">
// The crypto withdrawal package's entry. Holds the shell's selection until the network, token and
// address steps replace it; the shell reaches it exactly as it reaches a top-up package.
import Toolbar from "../../ui/Toolbar.vue";
import type { FundingPackageEmits } from "../../../funding/handoff";
import { fundingSelectorConfig } from "../../../funding/config";
import type { FundingSelection } from "../../../funding/selection";

const props = defineProps<{ selection: FundingSelection }>();
const emit = defineEmits<FundingPackageEmits>();

if (props.selection.route !== "crypto") {
  throw new Error(`the crypto withdrawal cannot handle the ${props.selection.route} route`);
}
</script>

<template>
  <!-- Toolbar and screen fill the visible viewport; the app never scrolls. -->
  <main
    class="fixed inset-x-0 mx-auto flex w-full max-w-md flex-col overflow-hidden bg-surface-main"
    style="
      top: var(--vvt, 0px);
      height: var(--vvh, 100dvh);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    "
  >
    <Toolbar title="Withdraw to crypto" back @back="emit('back')" />
    <section class="flex min-h-0 flex-1 flex-col items-center px-4 pt-8 text-center">
      <p class="text-display-m text-fg-primary">
        {{ selection.amount }} {{ fundingSelectorConfig.asset }}
      </p>
      <p class="mt-2 text-paragraph-l text-fg-secondary">Choosing the network comes next.</p>
    </section>
  </main>
</template>
