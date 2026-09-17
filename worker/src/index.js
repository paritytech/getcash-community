import { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
import { createKeepAlive } from "./keepalive.js";
import { startRpcDispatcher } from "./rpc.js";
import {
  hasLiveWithdrawals,
  startWithdraw,
  tickAllWithdrawals,
  withdrawStatus,
} from "../../withdraw/worker/index.ts";

// GetSome background worker: drives funding jobs handed over by the surface (startFunding),
// with records in product storage and the burner re-derived from host entropy on every wake.
// Bundled into a single `worker/index.js` before publishing (`pnpm build:worker`).

export { cancelFunding, fundingStatus, startFunding, tickAllFunding } from "./engine.js";
export {
  hasLiveWithdrawals,
  startWithdraw,
  tickAllWithdrawals,
  withdrawStatus,
} from "../../withdraw/worker/index.ts";

const keepAlive = createKeepAlive();
let handoffsInFlight = 0;
let workRevision = 0;

async function runHandoff(work, options = {}) {
  handoffsInFlight += 1;
  workRevision += 1;
  try {
    if (options.acquireBefore) {
      await keepAlive.acquire();
    }
    const result = await work();
    if (options.acquireAfterSuccess !== false && !result?.error) {
      workRevision += 1;
      await keepAlive.acquire();
    }
    return result;
  } finally {
    handoffsInFlight -= 1;
    workRevision += 1;
  }
}

function includesUnknownWork(params) {
  if (params && typeof params === "object") return params.includeUnknown === true;
  if (typeof params !== "string") return false;
  try {
    const parsed = JSON.parse(params);
    return !!parsed && typeof parsed === "object" && parsed.includeUnknown === true;
  } catch {
    return false;
  }
}

async function tickAllWork() {
  const [funding, withdrawal] = await Promise.allSettled([tickAllFunding(), tickAllWithdrawals()]);
  if (funding.status === "rejected") {
    console.warn(`[funding] tick failed: ${funding.reason}`);
  }
  if (withdrawal.status === "rejected") {
    console.warn(`[withdraw] tick failed: ${withdrawal.reason}`);
  }
  const failed = funding.status === "rejected" || withdrawal.status === "rejected";
  const ticked =
    (funding.status === "fulfilled" ? funding.value.ticked : 0) +
    (withdrawal.status === "fulfilled" ? withdrawal.value.ticked : 0);
  const busy =
    (funding.status === "fulfilled" && funding.value.busy) ||
    (withdrawal.status === "fulfilled" && withdrawal.value.busy);
  return { ticked, busy, failed };
}

// Adopt a predecessor's keep-alive operation while funding has work, close it otherwise.
// An unreadable store counts as work.
void keepAlive.restore(async () => {
  let withdrawLive = false;
  try {
    withdrawLive = await hasLiveWithdrawals();
  } catch (error) {
    console.warn(`[withdraw] restore could not read the jobs: ${error}`);
    withdrawLive = true;
  }
  try {
    const { ticked } = await tickAllFunding();
    return withdrawLive || ticked > 0;
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
    const revisionAtStart = workRevision;
    if (await hasLiveWithdrawals()) await keepAlive.acquire();
    const { ticked, busy, failed } = await tickAllWork();
    if (busy || failed || ticked > 0) {
      await keepAlive.acquire();
    } else if (handoffsInFlight === 0 && workRevision === revisionAtStart) {
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
    startFunding: (params) => runHandoff(() => startFunding(params)),
    tickAllFunding: () => tickAllFunding(),
    fundingStatus: (params) => fundingStatus(params),
    cancelFunding: (params) => cancelFunding(params),
    startWithdraw: (params) => runHandoff(() => startWithdraw(params)),
    tickAllWithdrawals: (params) =>
      includesUnknownWork(params)
        ? runHandoff(() => tickAllWithdrawals(params), {
            acquireBefore: true,
            acquireAfterSuccess: false,
          })
        : tickAllWithdrawals(params),
    withdrawStatus: (params) => withdrawStatus(params),
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
