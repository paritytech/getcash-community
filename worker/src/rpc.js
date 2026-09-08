import { hostLocalStorage } from "@novasamatech/host-api-wrapper";

/**
 * Storage-backed call channel, worker half. The page writes `seq` and the request keys; the
 * worker writes the response and claim keys and reads forward from the last sequence it
 * started. Each request runs on its own. Storage is polled.
 */
const SEQ_KEY = "getsome.rpc.seq";
const HEARTBEAT_KEY = "getsome.rpc.alive";
const HEARTBEAT_MS = 5_000;
const POLL_READ_TIMEOUT_MS = 4_000;
/** Delay before an answered call's keys are swept. */
const SWEEP_AFTER_MS = 60_000;
/** Requests written up to this long before this instance started are still answered. */
const STALE_AFTER_MS = 15_000;
const requestKey = (seq) => `getsome.rpc.req.${seq}`;
const responseKey = (seq) => `getsome.rpc.res.${seq}`;
// Written the moment a handler starts.
const claimKey = (seq) => `getsome.rpc.claim.${seq}`;

/**
 * Answers requests until stopped. `handlers` maps an api name to the export that serves it;
 * an unknown name answers `{error:"invalid"}`.
 */
export function startRpcDispatcher({ handlers, pollMs = 1_000, handlerTimeoutMs = 15_000 }) {
  const startedAt = Date.now();
  // The highest sequence handed to a handler; null until the first read (see bootstrap()).
  let dispatched = null;

  const log = (message) => {
    try {
      console.log(message);
    } catch {
      // No console available.
    }
  };
  const warn = (message) => {
    try {
      console.warn(message);
    } catch {
      // As above.
    }
  };

  // Heartbeat the page's isAvailable() reads.
  const heartbeat = setInterval(() => {
    void hostLocalStorage.writeJSON(HEARTBEAT_KEY, { at: Date.now() }).catch(() => {});
  }, HEARTBEAT_MS);
  void hostLocalStorage.writeJSON(HEARTBEAT_KEY, { at: Date.now() }).catch(() => {});

  /** Rejects when `promise` takes longer than `ms`. */
  function withTimeout(promise, what, ms = handlerTimeoutMs) {
    let timer = null;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
  }

  /** Clears a call's keys after SWEEP_AFTER_MS, for a page that died before its own cleanup. */
  function scheduleSweep(seq) {
    setTimeout(() => {
      for (const key of [requestKey(seq), responseKey(seq), claimKey(seq)]) {
        void hostLocalStorage.clear(key).catch(() => {});
      }
    }, SWEEP_AFTER_MS);
  }

  /** Starts every request up to `seq` that has not been started. A sequence that went
   *  backwards is a page that started counting again. */
  function dispatch(seq) {
    if (seq < dispatched) dispatched = seq - 1;
    const first = dispatched + 1;
    if (seq < first) return;
    dispatched = seq;
    for (let next = first; next <= seq; next += 1) {
      void answer(next).catch((error) => warn(`[rpc] #${next} could not be answered: ${error}`));
    }
  }

  const isStale = (request) => Number(request.at ?? 0) < startedAt - STALE_AFTER_MS;

  async function answer(seq) {
    const request = await hostLocalStorage.readJSON(requestKey(seq));
    // An absent request was abandoned by the page.
    if (!request) return;

    // A stale request's caller has already timed out.
    if (isStale(request)) return;

    const handler = handlers[request.api];
    if (!handler) {
      await hostLocalStorage.writeJSON(responseKey(seq), {
        error: "invalid",
        reason: `unknown api ${request.api}`,
      });
      scheduleSweep(seq);
      return;
    }

    await hostLocalStorage.writeJSON(claimKey(seq), { at: Date.now() });

    try {
      const value = await withTimeout(handler(request.payload ?? {}), request.api);
      // A refusal returned as data ({error, reason}) is written as an error.
      const refused = typeof value?.error === "string";
      await hostLocalStorage.writeJSON(
        responseKey(seq),
        refused ? { error: value.error, reason: value.reason } : { value: value ?? null },
      );
    } catch (error) {
      warn(`[rpc] ${request.api} (#${seq}) failed: ${error}`);
      await hostLocalStorage.writeJSON(responseKey(seq), {
        error: "crashed",
        reason: String(error?.message ?? error),
      });
    } finally {
      scheduleSweep(seq);
    }
  }

  let bootstrapping = false;
  /**
   * Walks back from `seq` to the last absent or stale request and dispatches from there.
   * Single-flight.
   */
  async function bootstrap(seq) {
    if (bootstrapping) return;
    bootstrapping = true;
    try {
      let cursor = seq;
      while (cursor > 0) {
        const request = await hostLocalStorage.readJSON(requestKey(cursor));
        if (!request || isStale(request)) break;
        cursor -= 1;
      }
      dispatched = cursor;
      log(`[rpc] listening from #${cursor + 1}`);
    } finally {
      bootstrapping = false;
    }
    dispatch(seq);
  }

  const poll = setInterval(() => {
    // A read that never answers fails after POLL_READ_TIMEOUT_MS.
    void withTimeout(hostLocalStorage.readJSON(SEQ_KEY), "poll read", POLL_READ_TIMEOUT_MS)
      .then((value) => {
        const seq = Number(value?.seq ?? 0);
        if (!Number.isFinite(seq)) return;
        if (dispatched === null) return bootstrap(seq);
        dispatch(seq);
      })
      .catch((error) => warn(`[rpc] poll failed: ${error}`));
  }, pollMs);

  return {
    stop() {
      clearInterval(heartbeat);
      clearInterval(poll);
    },
  };
}
