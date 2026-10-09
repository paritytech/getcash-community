<script setup lang="ts">
// The card payment step of a headless Meld order: the provider's card surface, mounted edge to edge
// by its SDK where the hosted widget would be, with the same states around it. Polls the Meld
// status from the moment it opens.
import { onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowDown, CircleAlert, CircleX } from "lucide-vue-next";
import { isEmbeddable, mountOrder, type MeldSurfaceError } from "~~/lib/meld-sdk";
import { useRequestsStore } from "../../../stores/requests";
import { useSessionStore } from "../../../stores/session";

const props = defineProps<{
  /** The adapter's verbatim Meld order; null while it is being placed, or once it is gone. */
  order: unknown;
  /** The order cannot be shown again: it was placed before the app was reopened. */
  lapsed?: boolean;
}>();
const emit = defineEmits<{ cancel: [] }>();

const session = useSessionStore();
const requests = useRequestsStore();

const NOT_EMBEDDABLE = "This payment can't be shown in the app.";
const NOT_LOADED = "The payment form couldn't load. Please try again.";
const FAILED = "Payment could not be completed";

const surface = ref<HTMLElement | null>(null);
/** Why the surface cannot take the payment; the order's own failure is the poll's to report. */
const failure = ref<string | null>(null);
let unmount: (() => void) | null = null;
/** One order per sheet: the surface is mounted once. */
let started = false;
let disposed = false;

function onError(error: MeldSurfaceError): void {
  // A declined card can be retried in the same surface, which says so itself.
  if (error.recoverable) return;
  console.warn(`[meld] card payment ended with an error${error.code ? ` (${error.code})` : ""}`);
  failure.value = error.message.trim() || FAILED;
}

function unmountSurface(): void {
  unmount?.();
  unmount = null;
}

async function mount(order: unknown, element: HTMLElement): Promise<void> {
  started = true;
  try {
    if (!(await isEmbeddable(order))) {
      failure.value = NOT_EMBEDDABLE;
      return;
    }
    unmount = await mountOrder(order, element, {
      onPaymentSubmitted: () => void session.markMeldSubmitted(),
      onCancel: () => emit("cancel"),
      onError,
    });
    if (disposed || surface.value === null) unmountSurface();
  } catch (e) {
    console.warn(
      `[meld] card surface failed to load: ${e instanceof Error ? e.message : String(e)}`,
    );
    if (!disposed) failure.value = NOT_LOADED;
  }
}

watch(
  [() => props.order, surface],
  ([order, element]) => {
    // The surface gives way to the states above it for good, so the provider's is taken down.
    if (element === null) unmountSurface();
    else if (order !== null && order !== undefined && !started) void mount(order, element);
  },
  { immediate: true },
);

onMounted(() => session.pollMeldStatus());
onUnmounted(() => {
  disposed = true;
  unmountSurface();
});
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    <!-- The same states as the hosted widget's sheet; the refund keeps its calm treatment. -->
    <div
      v-if="requests.meldStage === 'failed' && requests.meldRefunded"
      class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
    >
      <ArrowDown class="size-8 text-fg-primary" aria-hidden="true" />
      <p class="text-label-l font-semibold text-fg-primary">Payment refunded</p>
      <p class="max-w-[260px] text-body-m text-fg-secondary">
        {{
          requests.meldFailureMessage ??
          "Your payment was refunded. The money has been returned to you."
        }}
      </p>
    </div>
    <div
      v-else-if="requests.meldStage === 'failed' || failure !== null"
      class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 text-center"
    >
      <CircleX class="size-8 text-fg-error" aria-hidden="true" />
      <p class="max-w-[240px] text-label-m text-fg-error">
        {{ (requests.meldStage === "failed" ? requests.meldFailureMessage : failure) ?? FAILED }}
      </p>
    </div>
    <div
      v-else-if="requests.meldSubmitted"
      class="flex min-h-0 w-full flex-1 items-center justify-center"
    >
      <span
        class="size-8 animate-spin rounded-full border-[3px] border-stroke-primary border-t-fg-primary"
      />
    </div>
    <!-- No background of our own: the provider's surface paints itself. -->
    <div
      v-else-if="order !== null && order !== undefined"
      ref="surface"
      class="flex min-h-0 w-full flex-1 flex-col"
    />
    <div
      v-else-if="lapsed"
      class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <CircleAlert class="size-8 text-fg-secondary" aria-hidden="true" />
      <p class="text-label-l font-semibold text-fg-primary">Payment page closed</p>
      <p class="max-w-[260px] text-body-m text-fg-secondary">
        This payment can no longer be made here. If you have already paid, it will still arrive.
        Otherwise cancel it and start a new top-up.
      </p>
    </div>
    <p v-else class="flex-1 py-8 text-center text-body-m text-fg-tertiary">
      Preparing secure payment…
    </p>
  </div>
</template>
