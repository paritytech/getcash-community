<script setup lang="ts">
// A QR code read with the camera, full screen: the camera's picture under a mask that darkens
// towards the edges and keeps a square clear, framed in white, with a close button. The first code
// read is emitted and the camera let go. A camera refused or missing says so instead. Always dark,
// whatever the app's theme: it is drawn over a picture.
import jsQR from "jsqr";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { CameraError, openCamera, type CameraFailure } from "~~/lib/camera";
import { devLog } from "~~/lib/log";
import Toolbar from "../ui/Toolbar.vue";

const emit = defineEmits<{ scanned: [text: string]; close: [] }>();

/** The design's frame: a 342px square on a 390px screen, 24px in from each side and centred at
 *  48.3% of the height. Wider screens grow it up to 400px. */
const FRAME =
  "absolute inset-x-6 top-[48.3%] mx-auto aspect-square max-w-100 -translate-y-1/2 rounded-[24px]";
/** How often a frame is read, and its size, kept small enough to decode quickly on a phone. */
const READ_EVERY_MS = 150;
const READ_LONG_SIDE = 720;

const video = ref<HTMLVideoElement | null>(null);
const failure = ref<CameraFailure | null>(null);

const message = computed(() =>
  failure.value === "denied"
    ? "Allow camera access to scan a code."
    : "The camera isn't available. Paste the address instead.",
);

let stream: MediaStream | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let closed = false;
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });

function stop() {
  clearInterval(timer);
  stream?.getTracks().forEach((track) => track.stop());
}

/** One frame, scaled down, handed to jsQR. The first code found ends the scan. */
function read() {
  const picture = video.value;
  if (!context || !picture || picture.readyState < picture.HAVE_ENOUGH_DATA) return;
  const scale = Math.min(1, READ_LONG_SIDE / Math.max(picture.videoWidth, picture.videoHeight));
  const width = Math.round(picture.videoWidth * scale);
  const height = Math.round(picture.videoHeight * scale);
  canvas.width = width;
  canvas.height = height;
  context.drawImage(picture, 0, 0, width, height);
  // Dark codes on a light ground only: looking for light ones too doubles what a read costs.
  const code = jsQR(context.getImageData(0, 0, width, height).data, width, height, {
    inversionAttempts: "dontInvert",
  });
  if (code === null) return;
  stop();
  emit("scanned", code.data);
}

onMounted(async () => {
  try {
    stream = await openCamera();
  } catch (error: unknown) {
    devLog("withdraw", "the camera did not open", error, "warn");
    failure.value = error instanceof CameraError ? error.kind : "unavailable";
    return;
  }
  // Closed while the camera was opening: let it go at once.
  if (closed) {
    stop();
    return;
  }
  if (video.value) video.value.srcObject = stream;
  timer = setInterval(read, READ_EVERY_MS);
});

onBeforeUnmount(() => {
  closed = true;
  stop();
});
</script>

<template>
  <Teleport to="body">
    <div
      data-theme="berlin-night"
      class="fixed inset-0 z-50 overflow-hidden bg-surface-main"
      role="dialog"
      aria-modal="true"
      aria-label="Scan a QR code"
    >
      <video
        ref="video"
        class="absolute inset-0 size-full object-cover"
        autoplay
        muted
        playsinline
        aria-hidden="true"
      />
      <!-- Black around the frame, faded out towards the middle of the screen. -->
      <div
        class="pointer-events-none absolute inset-0 overflow-hidden mask-radial-[96%_50%] mask-radial-at-[50%_48.3%] mask-radial-from-transparent mask-radial-to-[#000]"
        aria-hidden="true"
      >
        <div :class="FRAME" class="shadow-[0_0_0_100vmax_#000]" />
      </div>
      <!-- WebKit shrinks an aspect-square box by its border and padding, so both sit on a child. -->
      <div :class="FRAME">
        <div
          class="absolute inset-0 flex items-center justify-center rounded-[inherit] border-4 border-fg-static-white px-6"
        >
          <p v-if="failure" class="text-center text-body-m text-fg-primary" role="alert">
            {{ message }}
          </p>
        </div>
      </div>
      <div class="relative mx-auto w-full max-w-md" style="padding-top: env(safe-area-inset-top)">
        <Toolbar back close @back="emit('close')" />
      </div>
    </div>
  </Teleport>
</template>
