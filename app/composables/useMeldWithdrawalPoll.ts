// Foreground polling for a Meld withdrawal's sale, owned by whichever screen created the sell
// session, on that same client.
//
// The requests store already reads every open Meld withdrawal's status in the background
// (`readBackgroundMeldWithdrawalStatuses`), but only when an adapter is configured
// (`VITE_MELD_BASE_URL`); without one — which is every build this step ships against, see
// `../withdraw/meld-client` — that background read is skipped entirely, the same way the buy
// side's own background poll is. A seller sitting on the KYC widget or the journey still needs to
// see the sale move, so this mirrors the store's `startMeldPoll` (the buy side's own foreground
// poll) at the same cadence: one read at a time, stopping once the sale is done.
//
// It calls the store's `observeMeldStatus` directly rather than duplicating its 404/gone handling,
// but owns its OWN client and scheduling — the store's foreground poll is keyed to a single
// concurrent request and a client the store built itself, and the fake client's scripted sell
// (see `packages/meld/src/fake.ts`) only progresses on the instance that opened it.

import { onUnmounted } from "vue";
import type { MeldClientLike } from "@getsome/meld";
import { MELD_POLL_MS } from "../funding/requests/model";
import { useMeldSellClients } from "../stores/meldSellClients";
import { useRequestsStore } from "../stores/requests";
import { requestRefKey, type RequestRef } from "../utils/request-index";

const SALE_DONE = new Set(["sent", "failed", "expired", "cancelled"]);

export function useMeldWithdrawalPoll() {
  const requests = useRequestsStore();
  const clients = useMeldSellClients();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  // Threaded across ticks the same way the store's own `startMeldPoll` threads it, not reset to 0
  // on every call: without this, `observeMeldStatus`'s escalation to an error-level log after
  // repeated failures never fires for a withdrawal, since every call would look like a first try.
  let failures = 0;

  function stop(): void {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Starts polling `fundingRequestId` for `ref` on `client`, until the record leaves the sale
   *  live (`sent`, or a side exit) or `stop` is called. Restarting replaces whatever was running. */
  function start(ref: RequestRef, client: MeldClientLike, fundingRequestId: string): void {
    stop();
    stopped = false;
    failures = 0;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      const outcome = await requests.observeMeldStatus(ref, client, fundingRequestId, failures);
      failures = outcome === "ok" ? 0 : failures + 1;
      if (stopped) return;
      const record = requests.get(ref);
      const done =
        outcome === "gone" ||
        record === undefined ||
        record.kind !== "withdrawal" ||
        SALE_DONE.has(record.status.kind);
      if (done) {
        // Nothing left to poll or resume on this client; free it rather than holding it for the
        // rest of the session. Harmless to call twice — `forget` on an unknown key is a no-op.
        clients.forget(requestRefKey(ref));
        return;
      }
      timer = setTimeout(() => void tick(), MELD_POLL_MS);
    };
    void tick();
  }

  onUnmounted(stop);
  return { start, stop };
}
