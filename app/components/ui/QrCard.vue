<script setup lang="ts">
// The QR as a dark-on-light rounded square, rendered at a fixed resolution and sized by CSS.
import { ref, watchEffect } from "vue";
import QRCode from "qrcode";

const props = defineProps<{ value: string }>();
const RESOLUTION = 512; // fixed render size; the display size is CSS-driven.
const canvas = ref<HTMLCanvasElement | null>(null);

watchEffect(() => {
  const el = canvas.value;
  if (!el || !props.value) return;
  void QRCode.toCanvas(el, props.value, {
    width: RESOLUTION,
    margin: 6,
    // Canvas pixels, not theme colours: wallet scanners expect a dark-on-light code
    // at maximum contrast in EVERY theme, so the QR is theme-invariant by design
    // (like a logo asset). Pure black/white beats any token here on purpose.
    color: { dark: "#000000", light: "#ffffff" },
  })
    .then(() => {
      // Clears the inline width/height qrcode writes onto the canvas.
      el.style.removeProperty("width");
      el.style.removeProperty("height");
    })
    .catch((e) => console.warn("[qr] render failed:", e));
});
</script>

<template>
  <!-- Sized by the parent's height, capped at 176px, square by aspect. -->
  <div class="aspect-square h-full max-h-44 overflow-hidden rounded-container shadow-1">
    <canvas ref="canvas" class="block size-full" />
  </div>
</template>
