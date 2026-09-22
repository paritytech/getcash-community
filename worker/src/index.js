import { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
import { createKeepAlive } from "./keepalive.js";
import { startRpcDispatcher } from "./rpc.js";
import {
  cancelWithdraw,
  startWithdraw,
  tickAllWithdraw,
  tickAllWithdrawReturn,
  withdrawStatus,
} from "./withdraw-engine.js";

// GetSome background worker: drives the funding and withdrawal jobs handed over by the surface
// (startFunding, startWithdraw), with records in product storage and the keys re-derived from
// host entropy on every wake. Bundled into a single `worker/index.js` before publishing
// (`pnpm build:worker`).
//
// tickAllWithdrawReturn is a third engine over the withdrawal job store (see
// withdraw-return-engine.js): it never drives a live withdrawal, only one already at rest, so
// it is folded into the same pass rather than given its own timer.

export { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
export {
  cancelWithdraw,
  startWithdraw,
  tickAllWithdraw,
  tickAllWithdrawReturn,
  withdrawStatus,
} from "./withdraw-engine.js";

const keepAlive = createKeepAlive();

/** One pass over every engine: how many jobs were ticked, and whether any engine still had a
 *  pass running, in which case the keep-alive is left as it is. */
async function tickAll() {
  const [funding, withdraw, withdrawReturn] = await Promise.all([
    tickAllFunding(),
    tickAllWithdraw(),
    tickAllWithdrawReturn(),
  ]);
  return {
    ticked: funding.ticked + withdraw.ticked + withdrawReturn.ticked,
    busy: funding.busy || withdraw.busy || withdrawReturn.busy,
  };
}

// Adopt a predecessor's keep-alive operation while either engine has work, close it otherwise.
// An unreadable store counts as work.
void keepAlive.restore(async () => {
  try {
    const { ticked } = await tickAll();
    return ticked > 0;
  } catch (error) {
    console.warn(`[worker] restore could not read the jobs: ${error}`);
    return true;
  }
});

/** Interval between passes on this worker's own timer. */
const TICK_MS = 6_000;

/** Runs one pass and holds the keep-alive while there is work left. */
async function pump() {
  try {
    const { ticked, busy } = await tickAll();
    if (busy) return;
    if (ticked > 0) {
      await keepAlive.acquire();
    } else {
      await keepAlive.release();
    }
  } catch (error) {
    console.warn(`[worker] tick failed: ${error}`);
  }
}

setInterval(() => void pump(), TICK_MS);

/** A hand-off takes the keep-alive itself. A refusal creates no job and takes nothing. */
const handoff = (start) => async (params) => {
  const result = await start(params);
  if (!result?.error) await keepAlive.acquire();
  return result;
};

// Page -> worker calls over shared product storage, started at module load.
startRpcDispatcher({
  handlers: {
    startFunding: handoff(startFunding),
    tickAllFunding: () => tickAllFunding(),
    fundingStatus: (params) => fundingStatus(params),
    cancelFunding: (params) => cancelFunding(params),
    startWithdraw: handoff(startWithdraw),
    tickAllWithdraw: () => tickAllWithdraw(),
    withdrawStatus: (params) => withdrawStatus(params),
    cancelWithdraw: (params) => cancelWithdraw(params),
  },
});

/** Host event export. A background wake runs one pass; unknown names are ignored. */
export async function onEvent(eventName) {
  if (eventName === "background.wake") {
    await pump();
  }
}

/** Host lifecycle exports. The engines persist after every tick and the keep-alive record is
 *  left for restore(). */
export async function onSuspend() {}

export async function onShutdown() {}
