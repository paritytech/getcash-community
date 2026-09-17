import { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
import { createKeepAlive } from "./keepalive.js";
import { paymentStatus, requestPayment } from "./payments.js";
import { startRpcDispatcher } from "./rpc.js";
import {
  cancelWithdraw,
  startWithdraw,
  tickAllWithdraw,
  withdrawStatus,
} from "./withdraw-engine.js";

// GetSome background worker: drives the funding and withdrawal jobs handed over by the surface
// (startFunding, startWithdraw), with records in product storage and the keys re-derived from
// host entropy on every wake, and makes the purse's payments to withdrawal keys on the surface's
// command. Bundled into a single `worker/index.js` before publishing (`pnpm build:worker`).

export { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
export { paymentStatus, requestPayment } from "./payments.js";
export {
  cancelWithdraw,
  startWithdraw,
  tickAllWithdraw,
  withdrawStatus,
} from "./withdraw-engine.js";

const keepAlive = createKeepAlive();

/** One pass over both engines: how many jobs were ticked, and whether either engine still had a
 *  pass running, in which case the keep-alive is left as it is. */
async function tickAll() {
  const [funding, withdraw] = await Promise.all([tickAllFunding(), tickAllWithdraw()]);
  return { ticked: funding.ticked + withdraw.ticked, busy: funding.busy || withdraw.busy };
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
    requestPayment: (params) => requestPayment(params),
    paymentStatus: (params) => paymentStatus(params),
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
