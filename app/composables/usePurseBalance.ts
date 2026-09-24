// The user's spendable CASH, read from the host purse once on mount and again on demand. Outside a
// host there is no purse, so the screen shows no pill.

import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { isHosted } from "~~/lib/host-account";

/** The purse as the page may read it, each state named so loading and no-purse can never swap:
 *  unknown is not "no purse" — the withdrawal gate fails closed on unknown and open only where
 *  there is provably nothing to cap. */
export type PurseBalanceState =
  | { kind: "unknown" } // a read in flight, or a read that failed
  | { kind: "none" } // no purse at all: outside a host, or the host offers no payments
  | { kind: "known"; balance: bigint }; // base units of CASH

export interface PurseBalance {
  state: Readonly<Ref<PurseBalanceState>>;
  /** True once the quick retries are spent without a read landing, so the screen can name the
   *  failure instead of holding a bare skeleton. Cleared by the read that finally lands. */
  failed: Readonly<Ref<boolean>>;
  /** Re-reads the purse. A known balance stands while the read is in flight — unless `spent`
   *  says the purse may have just been drawn down, where the last-read balance must not keep
   *  offering (or opening on) what is already gone: the state drops to unknown, closing the
   *  gate until the new read lands. */
  refresh: (options?: { spent?: boolean }) => Promise<void>;
}

// A failed read retries on its own: the gate fails closed on unknown, so without these a single
// transient host hiccup would leave the pill's skeleton and a dead CTA until a full reload.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
// Past the quick ladder the reads keep going at a walk, so a host that recovers while the screen
// is up heals it without anyone reloading.
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
      // A failed read leaves the balance unknown, not absent — reporting "no purse" here would
      // lift the withdrawal cap. A balance already read stands until a new read lands, so a
      // transient hiccup mid-refresh never collapses the pill to its skeleton or closes the
      // gate; only with nothing read yet does the pill hold its skeleton while the retries run.
      console.warn("[withdraw] purse balance unavailable:", error);
      if (run !== epoch) return;
      const delay = RETRY_DELAYS_MS[attempt];
      if (state.value.kind !== "known") {
        state.value = { kind: "unknown" };
        if (delay === undefined) failed.value = true;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        // A hidden tab holds its retry rather than polling a dead host in the background; the
        // visibilitychange below releases it, so recovery is immediate when the user returns
        // instead of on the next tick of a background clock.
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
    // The purse may have just been drawn down: what was known is stale in the one way that
    // matters, so the skeleton and the closed gate stand in until the new read lands.
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
