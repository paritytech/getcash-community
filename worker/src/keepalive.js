import { hostWorker, hostLocalStorage } from "@novasamatech/host-api-wrapper";

// The keep-alive operation is held while funding has work left. Its id is persisted so a
// successor instance can adopt or close it.

/** Storage key for the open keep-alive operation id. */
const OPERATION_KEY = "getsome.keepalive.op";

/** Refused closes in a row before the id is dropped as unknown to the host. */
const MAX_END_FAILURES = 3;

export function createKeepAlive({ label = "funding" } = {}) {
  let operationId = null;
  let endFailures = 0;
  // Serializes begin and end calls.
  let pending = Promise.resolve();

  function queue(work) {
    pending = pending.then(work, work);
    return pending;
  }

  async function remember(id) {
    try {
      if (id === null) await hostLocalStorage.clear(OPERATION_KEY);
      else await hostLocalStorage.writeJSON(OPERATION_KEY, { id, label, at: Date.now() });
    } catch (error) {
      console.warn(`[keepalive] could not persist operation id: ${error}`);
    }
  }

  async function begin() {
    if (operationId !== null) return;
    try {
      operationId = await hostWorker.beginOperation(label);
      await remember(operationId);
      console.log(`[keepalive] operation ${operationId} open`);
    } catch (error) {
      // Without the operation API the worker lives only as long as a surface is open.
      console.warn(`[keepalive] beginOperation unavailable: ${error}`);
    }
  }

  /** True once the operation is closed or given up on. A refused close keeps the id, in memory
   *  and in storage, for the next attempt, up to MAX_END_FAILURES times. */
  async function end(id) {
    try {
      await hostWorker.endOperation(id);
      console.log(`[keepalive] operation ${id} closed`);
    } catch (error) {
      endFailures += 1;
      if (endFailures < MAX_END_FAILURES) {
        console.warn(`[keepalive] endOperation ${id} failed: ${error}`);
        operationId = id;
        return false;
      }
      console.warn(`[keepalive] endOperation ${id} failed ${endFailures} times, dropping it`);
    }
    endFailures = 0;
    await remember(null);
    return true;
  }

  return {
    /**
     * Adopts an operation a previous instance left open, or closes it when `hasLiveWork`
     * answers false. Call once at startup, before the first acquire.
     */
    restore(hasLiveWork) {
      return queue(async () => {
        let stored = null;
        try {
          stored = await hostLocalStorage.readJSON(OPERATION_KEY);
        } catch (error) {
          console.warn(`[keepalive] could not read stored operation: ${error}`);
          return;
        }

        const id = stored?.id;
        if (typeof id !== "number") return;

        if (await hasLiveWork()) {
          operationId = id;
          console.log(`[keepalive] adopted operation ${id} from a previous instance`);
        } else {
          console.log(`[keepalive] closing orphaned operation ${id}`);
          await end(id);
        }
      });
    },

    /** Opens the operation if it is not already held. */
    acquire() {
      return queue(begin);
    },

    /** Closes the operation. Idempotent; a failed close is retried on the next call. */
    release() {
      return queue(async () => {
        if (operationId === null) return;
        if (await end(operationId)) operationId = null;
      });
    },

    isHeld: () => operationId !== null,
  };
}
