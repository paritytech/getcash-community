// The reveal state behind a return-funds guide: the address on sight, the secret behind a tap.
//
// Shared by the top-up and withdrawal guides because the mistake it prevents is the same one on
// both: address and secret must come out of a single derivation. A screen that sources them apart
// can show a funded address beside a key that opens a different, empty account — on the one screen
// whose job is getting money back.

import { computed, readonly, ref, watch } from "vue";

/** Address and secret from one derivation. `RefundKey` and `WithdrawRefundKey` both satisfy it. */
export interface RecoveryKeyMaterial {
  readonly address: string;
  readonly secret: string;
  readonly format?: "wif" | "hex" | "base58";
}

export interface RecoveryKeyOptions {
  /** Derives the key. Null when there is no entropy root to derive from, as off-host. */
  resolve: () => Promise<RecoveryKeyMaterial | null> | RecoveryKeyMaterial | null;
  /** Which key is on screen. A change means another request took it, and what is held is stale. */
  identity?: () => string | null;
  /** The address as it is known apart from the derivation; the derived one must agree with it. */
  known?: () => string | null | undefined;
  /** Preview deck only: reveals without a tap, once the scene has installed what it needs. */
  autoReveal?: () => boolean;
}

export function useRecoveryKey(options: RecoveryKeyOptions) {
  const held = ref<RecoveryKeyMaterial | null>(null);
  const masked = ref(true);
  const resolving = ref(false);
  /** A resolve came back empty, threw, or disagreed. Cleared whenever the next one starts. */
  const failed = ref(false);
  /** Bumped on reset; a resolve landing under a stale epoch is for a key no longer on screen. */
  let epoch = 0;

  const knownAddress = computed(() => options.known?.() ?? null);

  async function derive(): Promise<boolean> {
    const mine = ++epoch;
    resolving.value = true;
    failed.value = false;
    try {
      const material = await options.resolve();
      if (mine !== epoch) return false;
      if (material === null) {
        failed.value = true;
        return false;
      }
      const expected = knownAddress.value;
      if (expected !== null && expected !== material.address) {
        // The root answering now is not the one this key was written under, so the address on
        // screen and this secret are different accounts. Handing it over sends the user to import
        // a key that opens nothing.
        console.warn("[recovery] the derived address is not the record's; withholding the key");
        failed.value = true;
        return false;
      }
      held.value = material;
      return true;
    } catch (error: unknown) {
      if (mine !== epoch) return false;
      console.warn("[recovery] the key could not be derived:", error);
      failed.value = true;
      return false;
    } finally {
      if (mine === epoch) resolving.value = false;
    }
  }

  async function toggle(): Promise<void> {
    if (!masked.value) {
      masked.value = true;
      return;
    }
    if (held.value === null && !(await derive())) return;
    masked.value = false;
  }

  // Derived up front only when nothing else can supply the address, since then the guide's first
  // step has nothing to point at. With the address already known the secret waits for the tap.
  watch(
    () => [options.identity?.() ?? null, knownAddress.value] as const,
    () => {
      epoch++;
      held.value = null;
      masked.value = true;
      failed.value = false;
      resolving.value = false;
      // A staged scene re-reveals after the reset; otherwise only a guide with no other source
      // for the address derives without being asked.
      if (options.autoReveal?.()) void toggle();
      else if (knownAddress.value === null) void derive();
    },
    { immediate: true },
  );

  if (options.autoReveal) {
    watch(
      options.autoReveal,
      (want, staged) => {
        if (want && masked.value) void toggle();
        // Stepping back off a staged scene puts the key away again; `staged` is undefined on the
        // first run, so a guide that simply opens unstaged is left alone.
        else if (!want && staged) masked.value = true;
      },
      { immediate: true },
    );
  }

  return {
    /** Where the funds are: the derived address once held, the independently known one before. */
    address: computed(() => held.value?.address ?? knownAddress.value),
    /** Null until revealed: deriving the address up front must not put the secret on the screen. */
    secret: computed(() => (masked.value ? null : (held.value?.secret ?? null))),
    format: computed(() => held.value?.format),
    masked: readonly(masked),
    /** Whether there is anything to show; false leaves the guide with no address and no key. */
    material: computed(() => held.value !== null || knownAddress.value !== null),
    /** The key cannot be reached on this device. Settled: never true while a derive is running. */
    unavailable: computed(() => failed.value && !resolving.value),
    resolving: readonly(resolving),
    toggle,
  };
}
