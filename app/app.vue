<script setup lang="ts">
import HostUnavailableScreen from "./components/HostUnavailableScreen.vue";
import { Toaster } from "./components/ui/sonner";
import { useHostGate } from "./composables/useHostGate";
import { useHostTheme } from "./composables/useHostTheme";
import { useResolvedThemeKind } from "./composables/useResolvedThemeKind";

// Hosted: the Polkadot app owns the theme; follow it. Standalone: no-op.
useHostTheme();

const themeKind = useResolvedThemeKind();

// Development builds open only once the host serves the chains; see useHostGate.
const { state: hostGate, retry: retryHostGate } = useHostGate();
</script>

<template>
  <NuxtPage v-if="hostGate.kind === 'ready'" />
  <HostUnavailableScreen
    v-else-if="hostGate.kind === 'unreachable'"
    :reason="hostGate.reason"
    @retry="retryHostGate"
  />
  <main
    v-else
    class="fixed inset-0 flex items-center justify-center bg-surface-main text-body-m text-fg-secondary"
  >
    Connecting…
  </main>
  <!-- Undo toasts live here (act, then offer undo — never a confirmation dialog).
       top-center: the app column is centred in the viewport, so viewport-centre
       and content-centre coincide. -->
  <Toaster :theme="themeKind" position="top-center" />
</template>
