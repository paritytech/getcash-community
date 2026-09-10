<script setup lang="ts">
import { Toaster } from "./components/ui/sonner";
import { useHostTheme } from "./composables/useHostTheme";
import { useResolvedThemeKind } from "./composables/useResolvedThemeKind";

// Build stamp: bump on every change so a cached bundle is distinguishable from a fresh
// one. If the console does not show THIS tag after a reload, the host serves stale code.
const BUILD = "nuxt-p7-7";
console.info(`[getsome] build ${BUILD}`);

// Hosted: the Polkadot app owns the theme; follow it. Standalone: no-op.
useHostTheme();

const themeKind = useResolvedThemeKind();
</script>

<template>
  <NuxtPage />
  <!-- Undo toasts live here (act, then offer undo — never a confirmation dialog).
       top-center: the app column is centred in the viewport, so viewport-centre
       and content-centre coincide. -->
  <Toaster :theme="themeKind" position="top-center" />
</template>
