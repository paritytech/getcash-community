<script setup lang="ts">
import BottomSheet from "./components/ui/BottomSheet.vue";
import { Toaster } from "./components/ui/sonner";
import { useHostGate } from "./composables/useHostGate";
import { useHostTheme } from "./composables/useHostTheme";
import { useResolvedThemeKind } from "./composables/useResolvedThemeKind";

// Hosted: the Polkadot app owns the theme; follow it. Standalone: no-op.
useHostTheme();

const themeKind = useResolvedThemeKind();

// TEMPORARY: see useHostGate.ts.
const { incompatible } = useHostGate();
</script>

<template>
  <NuxtPage />
  <!-- Undo toasts live here (act, then offer undo — never a confirmation dialog).
       top-center: the app column is centred in the viewport, so viewport-centre
       and content-centre coincide. -->
  <Toaster :theme="themeKind" position="top-center" />
  <!-- TEMPORARY: see useHostGate.ts. No dismiss, no retry: the host setting needs a relaunch to
       take effect anyway, so there is nothing a tap here could usefully do. -->
  <BottomSheet :open="incompatible">
    <div class="flex flex-col gap-1 p-6 text-center">
      <p class="text-heading-m text-fg-primary">TrUAPI runtime isn't supported</p>
      <p class="text-body-s text-fg-secondary">Turn it off in the dev menu, then reopen Cash.</p>
    </div>
  </BottomSheet>
</template>
