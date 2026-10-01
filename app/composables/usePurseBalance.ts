// The user's spendable CASH, read from the host purse once on mount and again on demand. Outside a
// host there is no purse, so the screen shows no pill.

import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { isHosted } from "~~/lib/host-account";

/** Each state named so loading and no-purse can never swap: the withdrawal gate fails closed
 *  on unknown, open only where there is provably nothing to cap. */
export type PurseBalanceState =
  | { kind: "unknown" } // a read in flight, or a read that failed
  | { kind: "none" } // no purse at all: outside a host, or the host offers no payments
  | { kind: "known"; balance: bigint }; // base units of CASH

export interface PurseBalance {
  state: Readonly<Ref<PurseBalanceState>>;
  /** True once the quick retries are spent, so the screen can name the failure; cleared by the
   *  read that finally lands. */
  failed: Readonly<Ref<boolean>>;
  /** Re-reads the purse. A known balance stands while the read is in flight, unless `spent`
   *  says it may just have been drawn down — then the state drops to unknown until the read lands. */
  refresh: (options?: { spent?: boolean }) => Promise<void>;
}

// The gate fails closed on unknown, so a transient host hiccup must retry on its own.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
// Past the quick ladder, a slow walk heals a host that recovers while the screen is up.
const RETRY_STEADY_MS = 30_000;

export function usePurseBalance(): PurseBalance {
  // Known at once outside a host, so the screen never shows a pill it is about to drop.
  const state = ref<PurseBalanceState>(isHosted() ? { kind: "unknown" } : { kind: "none" });
  const failed = ref(false);

  // Each refresh() starts a new read chain and orphans the old one's pending retry.
  let epoch = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // A retry that came due while the tab was hidden, held for visibilitychange to release.
  let heldRetry: (() => void) | null = null;

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    heldRetry = null;
  }

  function releaseHeldRetry(): void {
    if (document.hidden || heldRetry === null) return;
    const retry = heldRetry;
    heldRetry = null;
    retry();
  }

  async function read(run: number, attempt: number): Promise<void> {
    if (!isHosted()) {
      state.value = { kind: "none" };
      failed.value = false;
      return;
    }
    try {
      const [{ getPaymentManager }, { readPurseBalance }] = await Promise.all([
        import("@parity/product-sdk-host"),
        import("~~/lib/coinage"),
      ]);
      const payments = await getPaymentManager();
      const next: PurseBalanceState = payments
        ? { kind: "known", balance: await readPurseBalance(payments) }
        : { kind: "none" };
      if (run !== epoch) return;
      state.value = next;
      failed.value = false;
    } catch (error: unknown) {
      // Unknown, not absent — "no purse" would lift the withdrawal cap. A balance already read
      // stands, so a hiccup mid-refresh never collapses the pill or closes the gate.
      console.warn("[withdraw] purse balance unavailable:", error);
      if (run !== epoch) return;
      const delay = RETRY_DELAYS_MS[attempt];
      if (state.value.kind !== "known") {
        state.value = { kind: "unknown" };
        if (delay === undefined) failed.value = true;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        // A hidden tab holds its retry; visibilitychange releases it on return.
        if (typeof document !== "undefined" && document.hidden) {
          heldRetry = () => void read(run, attempt + 1);
          return;
        }
        void read(run, attempt + 1);
      }, delay ?? RETRY_STEADY_MS);
    }
  }

  async function refresh(options?: { spent?: boolean }): Promise<void> {
    cancelRetry();
    // Drawn-down purse: the skeleton and the closed gate stand in until the new read lands.
    if (options?.spent === true && state.value.kind === "known") state.value = { kind: "unknown" };
    await read(++epoch, 0);
  }

  onMounted(() => {
    void refresh();
    document.addEventListener("visibilitychange", releaseHeldRetry);
  });
  onUnmounted(() => {
    cancelRetry();
    epoch += 1;
    document.removeEventListener("visibilitychange", releaseHeldRetry);
  });
  return { state, failed, refresh };
}
