import { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
import { createKeepAlive } from "./keepalive.js";
import { startRpcDispatcher } from "./rpc.js";

// GetSome background worker: drives funding jobs handed over by the surface (startFunding),
// with records in product storage and the burner re-derived from host entropy on every wake.
// Bundled into a single `worker/index.js` before publishing (`pnpm build:worker`).

export { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";

const keepAlive = createKeepAlive();

// Adopt a predecessor's keep-alive operation while funding has work, close it otherwise.
// An unreadable store counts as work.
void keepAlive.restore(async () => {
  try {
    const { ticked } = await tickAllFunding();
    return ticked > 0;
  } catch (error) {
    console.warn(`[funding] restore could not read the jobs: ${error}`);
    return true;
  }
});

/** Interval between funding passes on this worker's own timer. */
const FUNDING_TICK_MS = 6_000;

/** Runs one funding pass and holds the keep-alive while there is work left. */
async function pumpFunding() {
  try {
    const { ticked, busy } = await tickAllFunding();
    if (busy) return;
    if (ticked > 0) {
      await keepAlive.acquire();
    } else {
      await keepAlive.release();
    }
  } catch (error) {
    console.warn(`[funding] tick failed: ${error}`);
  }
}

setInterval(() => void pumpFunding(), FUNDING_TICK_MS);

// Page -> worker calls over shared product storage, started at module load.
startRpcDispatcher({
  handlers: {
    // The keep-alive is taken on the handoff itself. A refusal creates no job and takes nothing.
    startFunding: async (params) => {
      const result = await startFunding(params);
      if (!result?.error) await keepAlive.acquire();
      return result;
    },
    tickAllFunding: () => tickAllFunding(),
    fundingStatus: (params) => fundingStatus(params),
    cancelFunding: (params) => cancelFunding(params),
  },
});

/** Host event export. A background wake runs one funding pass; unknown names are ignored. */
export async function onEvent(eventName) {
  if (eventName === "background.wake") {
    await pumpFunding();
  }
}

/** Host lifecycle exports. The engine persists after every tick and the keep-alive record
 *  is left for restore(). */
export async function onSuspend() {}

export async function onShutdown() {}
