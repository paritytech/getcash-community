<script setup lang="ts">
// A page for developers. It runs the checks of the bridge routes from inside the product, to
// show what the host lets through. Nothing is sent. It shows only on the preview of a pull
// request and on a developer's copy.
import { ref } from "vue";
import { useRouter } from "vue-router";
import ScreenShell from "../components/ui/ScreenShell.vue";
import SecondaryButton from "../components/ui/SecondaryButton.vue";
import { isPreviewOrLocal } from "../utils/pr-preview";
import { BRIDGE_CHECK_DOMAINS, runBridgeCheck, type BridgeCheckLine } from "~~/lib/bridge-check";
import { isHosted } from "~~/lib/host-account";

const router = useRouter();
const allowed = isPreviewOrLocal({ hostname: location.hostname, protocol: location.protocol });
if (!allowed) void router.replace("/");

const lines = ref<BridgeCheckLine[]>([]);
const running = ref(false);

/** Asks the host to let the page reach the nodes of the checks. */
async function grant(): Promise<BridgeCheckLine> {
  const label = "The host's grant for the network";
  const from = Date.now();
  try {
    const { requestPermission } = await import("@parity/product-sdk-host");
    const result = await requestPermission({
      tag: "Remote",
      value: { domains: [...BRIDGE_CHECK_DOMAINS] },
    });
    const ok = result.ok && result.value === true;
    return {
      label,
      ok,
      ms: Date.now() - from,
      detail: ok ? `granted for ${BRIDGE_CHECK_DOMAINS.length} domains` : "the host refused",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { label, ok: false, ms: Date.now() - from, detail };
  }
}

async function run(): Promise<void> {
  if (running.value) return;
  running.value = true;
  lines.value = [];
  if (isHosted()) lines.value.push(await grant());
  await runBridgeCheck((line) => lines.value.push(line));
  running.value = false;
}
</script>

<template>
  <ScreenShell v-if="allowed" title="Bridge check" back @back="router.push('/')">
    <div class="flex min-h-0 flex-1 flex-col gap-6">
      <p class="text-body-m text-fg-secondary">
        Reads the two bridge routes from inside this app. Nothing is sent.
      </p>
      <SecondaryButton
        class="cursor-pointer self-start disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-action-secondary"
        :disabled="running"
        @click="run"
      >
        {{ running ? "Running" : "Run the checks" }}
      </SecondaryButton>
      <ul class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-8" aria-live="polite">
        <li v-for="line in lines" :key="line.label" class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-label-m" :class="line.ok ? 'text-fg-primary' : 'text-fg-error'">
              {{ line.label }}
            </span>
            <span class="shrink-0 font-mono text-caption text-fg-tertiary">
              {{ line.ok ? `${line.ms} ms` : `failed, ${line.ms} ms` }}
            </span>
          </div>
          <p class="break-words text-body-s text-fg-secondary">{{ line.detail }}</p>
        </li>
      </ul>
    </div>
  </ScreenShell>
</template>
