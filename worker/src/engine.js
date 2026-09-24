import { readTopUpStatus, registerTopUp } from "./host.js";
import { toSchnorrkelSecret } from "@getsome/ephemeral";
import {
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  DEFAULT_SLIPPAGE_PCT,
  DEFAULT_SUBMIT_TIMEOUT_MS,
  DEFAULT_TICK_TIMEOUT_MS,
  FundingHeldError,
  FundingShortfallError,
  PASEO_ASSET_HUB_PARA_ID,
  discoverPool,
  freshTickState,
  recordedRoute,
  tickOnce,
} from "@getsome/funding";
import { CASH_SETTLEMENT, createPeopleChainPort } from "@getsome/people";
import { PaymentTopUpErr, PaymentTopUpStatusErr } from "@novasamatech/host-api";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { readParams } from "./params.js";
import {
  asBig,
  bounded,
  connectChain,
  createJobStore,
  keypairFor,
  signOptionsFor,
  toHex,
} from "./shared.js";
import { topUpIdFor } from "./topup-id.js";

// The funding engine: the only driver of tickOnce, one tick per live job per pass.
//
// Once this engine holds a job it is the only writer for it. The surface only reads records back.
// Each dispatch runs at most one tick per live job, persists what it learned, and exits.
// Records carry the entropy label, never a secret; the burner key is re-derived on every wake.

/** Bump when the record shape changes; readers skip versions they don't know. */
const RECORD_V = 2;

/** Storage key for the job map, keyed by session id. */
const FUNDING_KEY = "getsome.funding.jobs";

/**
 * Worker time the conversion and the claim's registration may take once funds are seen (see
 * accountWorkedTime). Once registered, the claim is the host's and runs on CLAIM_TRACK_WINDOW_MS.
 */
const RUN_TIMEOUT_MS = 900_000;
/** A gap between ticks longer than this means the worker was not running in between. */
const MAX_TICK_GAP_MS = 30_000;
/** A job whose deposit never arrives is retired after this, releasing the keep-alive. */
const DEPOSIT_WINDOW_MS = 86_400_000;

const store = createJobStore(FUNDING_KEY, "funding");
const loadJobs = () => store.load();
const saveJobs = () => store.save();

/**
 * One funding job's record, as persisted between wakes.
 *
 * {
 *   v: 1, sessionId, label,                  // label: the entropy label the surface used
 *   burnerAddress,                           // the address the surface showed
 *   depositExpiresAt: number|null,           // the rail's deposit deadline
 *   settleAmount, remoteFeeBuffer, keepNativeForFees, slippagePct,   // bigints as strings
 *   quotedDeposit?,                                                  // psm tier, bigint as string
 *   underlyingAssetId, peopleParaId, assetHubGenesis, peopleGenesis,
 *   tier: "pool" | "psm", external?, feeRate?, // the conversion route the surface decided at
 *                                            // quote time; consumed here, never re-decided
 *   phase: "starting" | FundingStep | "failed",  // await-native: the route's deposit asset
 *   failure?: "shortfall" | "timeout" | "expired" | "cancelled" | "claim" | "held",
 *                                            // held: the PSM refused the mint three times; the
 *                                            // deposit stays on the burner
 *   done, createdAt, armedAt, lastTickAt, lastError?,
 *   state: { attempts, psmRefusals, xcmSubmitted, peopleAtXcm: string,
 *            fundsSeenAt: number|null, workedMs },
 *                                            // attempts: submits so far
 *                                            // psmRefusals: PSM refusals so far, not transport
 *   submitting?: { call: "swap", at },        // written before a submit
 *   txs: [{ call, txHash, block? }],
 *   claim?: { phase: "sizing"|"registering"|"claiming"|"claimed", attempt, credited,
 *             id?, amount?, at, attempts, registeredAt?, status?, partial?, error? },
 *                                            // attempt: 0-based; each has its own id (hex)
 *                                            // credited: CASH the host minted so far
 *                                            // status: the host's last word on the top-up
 * }
 */
function newRecord(input, nowMs) {
  const sessionId = String(input.sessionId ?? "");
  const label = String(input.label ?? "");
  const settleAmount = asBig(input.settleAmount, -1n);
  const assetHubGenesis = String(input.assetHubGenesis ?? "");
  const peopleGenesis = String(input.peopleGenesis ?? "");
  const underlyingAssetId = Number(input.underlyingAssetId);
  const peopleParaId = Number(input.peopleParaId);
  const burnerAddress = String(input.burnerAddress ?? "");
  if (!sessionId) throw new Error("startFunding: sessionId is required");
  if (!label) throw new Error("startFunding: the entropy label is required");
  if (!burnerAddress) throw new Error("startFunding: the surface's burner address is required");
  // Amounts below one claim unit floor to nothing.
  if (settleAmount < CLAIM_UNIT) {
    throw new Error(`startFunding: settleAmount must be at least ${CLAIM_UNIT}`);
  }
  if (!assetHubGenesis || !peopleGenesis) {
    throw new Error("startFunding: both chain genesis hashes are required");
  }
  if (!Number.isInteger(underlyingAssetId) || !Number.isInteger(peopleParaId)) {
    throw new Error("startFunding: underlyingAssetId and peopleParaId must be integers");
  }
  // The route is the surface's decision, taken once at quote time; a hand-off whose psm route
  // lacks its fee is refused here rather than guessed at.
  const route = recordedRoute(input);
  return {
    v: RECORD_V,
    sessionId,
    label,
    burnerAddress,
    depositExpiresAt: depositExpiryOf(input),
    settleAmount: settleAmount.toString(),
    remoteFeeBuffer: asBig(input.remoteFeeBuffer, DEFAULT_REMOTE_FEE_BUFFER).toString(),
    keepNativeForFees: asBig(input.keepNativeForFees, DEFAULT_KEEP_NATIVE_FOR_FEES).toString(),
    slippagePct: Number(input.slippagePct) > 0 ? Number(input.slippagePct) : DEFAULT_SLIPPAGE_PCT,
    // The PSM tier's gate waits for the deposit the quote asked for. Absent on a pool job and on
    // anything quoted before it was recorded.
    ...(typeof input.quotedDeposit === "string" ? { quotedDeposit: input.quotedDeposit } : {}),
    underlyingAssetId,
    peopleParaId,
    assetHubGenesis,
    peopleGenesis,
    ...route,
    phase: "starting",
    done: false,
    createdAt: nowMs,
    armedAt: nowMs,
    lastTickAt: null,
    state: freshRecordState(),
    txs: [],
  };
}

const freshRecordState = () => ({
  attempts: 0,
  psmRefusals: 0,
  xcmSubmitted: false,
  peopleAtXcm: "0",
  fundsSeenAt: null,
  workedMs: 0,
});

/**
 * Registers a session handed over by the surface. Idempotent on sessionId.
 * Returns the record's public view; driving happens on wakes.
 */
export async function startFunding(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const existing = all[String(input.sessionId ?? "")];
  if (existing) {
    // A record of an unknown version is refused, not overwritten.
    if (existing.v !== RECORD_V) {
      return { error: "invalid", reason: `session exists with record v${existing.v}` };
    }
    const mismatch = await burnerMismatch(existing, String(input.burnerAddress ?? ""));
    if (mismatch) return { error: "invalid", reason: mismatch };
    if (existing.phase === "failed") {
      rearm(existing, Date.now());
      existing.depositExpiresAt = depositExpiryOf(input) ?? existing.depositExpiresAt;
    }
    await saveJobs();
    return describeFunding(existing);
  }
  let record;
  try {
    record = newRecord(input, Date.now());
  } catch (error) {
    // Refusals are returned as data; the surface receives them as WorkerCallError("invalid",
    // reason).
    return { error: "invalid", reason: String(error?.message ?? error) };
  }
  const burner = await keypairFor(record.label);
  if (burner.address !== record.burnerAddress) {
    return { error: "invalid", reason: mismatchReason(burner.address, record.burnerAddress) };
  }
  all[record.sessionId] = record;
  await saveJobs();
  return describeFunding(record);
}

const mismatchReason = (derived, shown) =>
  `burner mismatch: the worker derives ${derived} for this label, the surface shows ${shown}`;

/**
 * Returns a reason when `shown` differs from the burner address this worker derives.
 * A record without an address is checked against a fresh derivation and adopts it.
 */
async function burnerMismatch(record, shown) {
  if (!shown) return null;
  const known = record.burnerAddress ?? (await keypairFor(record.label)).address;
  if (shown !== known) return mismatchReason(known, shown);
  record.burnerAddress = known;
  return null;
}

/** The rail's deposit deadline, or null when the rail gave none. */
const depositExpiryOf = (input) => {
  const at = Number(input.depositExpiresAt);
  return Number.isFinite(at) && at > 0 ? at : null;
};

/**
 * Re-arms a failed job on a re-sent hand-off. The run clock, the deposit window and the claim's
 * tracking window restart. Submit latches survive except after a shortfall; a held job gets a
 * fresh refusal counter, for a ceiling raised since; a claim that was still registering is
 * retried at once, and a claim the host settled short gets a fresh attempt.
 */
function rearm(record, nowMs) {
  record.phase = record.done ? "done" : "starting";
  // Older records carry the failure kind in the reason only.
  const failure =
    record.failure ?? (record.lastError?.startsWith("shortfall") ? "shortfall" : null);
  delete record.failure;
  delete record.lastError;
  record.armedAt = nowMs;
  // The clock restarts; a finished funding leg keeps its deposit timestamp.
  if (!record.done) record.state.fundsSeenAt = null;
  record.state.workedMs = 0;
  if (failure === "shortfall") {
    record.state.attempts = 0;
    record.state.xcmSubmitted = false;
    record.state.peopleAtXcm = "0";
  }
  if (failure === "held") record.state.psmRefusals = 0;
  if (record.claim?.phase === "registering") {
    record.claim = { ...record.claim, attempts: 0, at: 0 };
  }
  if (record.claim?.phase === "claiming") {
    record.claim =
      failure === "claim" ? nextAttempt(record.claim) : { ...record.claim, registeredAt: nowMs };
  }
}

function fail(record, failure, reason) {
  record.phase = "failed";
  record.failure = failure;
  record.lastError = reason;
}

/**
 * Marks a job still waiting for its deposit as cancelled. The record is kept, and a re-sent
 * hand-off re-arms it. A job that has seen funds is left running.
 */
export async function cancelFunding(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const record = all[String(input.sessionId ?? "")];
  if (!record) return { sessionId: String(input.sessionId ?? ""), known: false };
  const waitingForDeposit = !record.done && record.state.fundsSeenAt === null;
  if (waitingForDeposit && record.phase !== "failed") {
    fail(record, "cancelled", "cancelled by the surface");
    await saveJobs();
  }
  return describeFunding(record);
}

/** True once the CASH has landed and been claimed; `done` alone means the funding leg is over. */
const isFinished = (record) => record.done === true && record.claim?.phase === "claimed";

/** The burner's CASH on People, floored to the claim unit. */
async function claimableOn(peoplePort, burner, what) {
  const held = await bounded(
    peoplePort.settlementBalance(burner.address, CASH_SETTLEMENT),
    DEFAULT_TICK_TIMEOUT_MS,
    what,
  );
  return (held / CLAIM_UNIT) * CLAIM_UNIT;
}

/**
 * Claims are multiples of 0.01 CASH (6 decimals): the coinage instance's asset unit, so a
 * registered amount is exactly what the host can mint.
 */
const CLAIM_UNIT = 10_000n;
/** Timeout for one host top-up call or status read. */
const CLAIM_TIMEOUT_MS = 45_000;
/** Minimum wait before a failed registration is retried. */
const CLAIM_RETRY_MS = 180_000;
/** Time a registered claim may stay unsettled on the host before the job is failed. */
const CLAIM_TRACK_WINDOW_MS = 5_400_000;
/** Registrations a job makes on its own before it settles for what the host credited. */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Claims the burner's CASH into the purse once the funding leg is done. Each attempt sizes the
 * burner, registers that amount with the host under an id derived from the burner's public key,
 * and follows the top-up to its terminal status; the host drives it from registration on. A
 * top-up the host settles short leaves CASH on the burner, and the next attempt claims it. The
 * `registering` marker is written before the call, so a wake that finds it re-registers, and
 * `AlreadyExists` counts as registered.
 */
async function claimFor(record, burner, peoplePort) {
  const claim = record.claim ?? null;
  if (claim?.phase === "claimed") return;
  if (claim?.phase === "claiming") {
    await followClaim(record, burner);
    return;
  }
  if (claim?.phase === "registering") {
    if (Date.now() - claim.at < CLAIM_RETRY_MS) return;
    await registerClaim(record, burner);
    return;
  }

  const amount = await claimableOn(peoplePort, burner, "burner CASH read");
  if (amount === 0n) {
    if (claim?.phase === "sizing") settleOnCredited(record);
    return;
  }
  const attempt = claim?.attempt ?? 0;
  record.claim = {
    phase: "registering",
    attempt,
    credited: claim?.credited ?? "0",
    id: toHex(topUpIdFor(burner.publicKey, attempt)),
    amount: amount.toString(),
    at: 0,
    attempts: 0,
  };
  await saveJobs();
  await registerClaim(record, burner);
}

async function registerClaim(record, burner) {
  record.claim = { ...record.claim, at: Date.now(), attempts: record.claim.attempts + 1 };
  await saveJobs();
  try {
    // The host expects the secret in schnorrkel's canonical layout.
    const hostSecret = toSchnorrkelSecret(burner.secretKey);
    await bounded(
      registerTopUp(
        asBig(record.claim.amount),
        hostSecret,
        topUpIdFor(burner.publicKey, record.claim.attempt),
      ),
      CLAIM_TIMEOUT_MS,
      "topUp",
    );
  } catch (error) {
    if (error instanceof PaymentTopUpErr.InvalidSource) {
      fail(record, "claim", "the host refused the burner as a top-up source");
      return;
    }
    if (!(error instanceof PaymentTopUpErr.AlreadyExists)) {
      record.claim = { ...record.claim, error: String(error?.message ?? error) };
      throw error;
    }
  }
  delete record.claim.error;
  record.claim = { ...record.claim, phase: "claiming", registeredAt: Date.now() };
}

async function followClaim(record, burner) {
  let status;
  try {
    status = await readTopUpStatus(
      topUpIdFor(burner.publicKey, record.claim.attempt),
      CLAIM_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof PaymentTopUpStatusErr.NotFound) {
      record.claim = { ...record.claim, phase: "registering", at: 0 };
      return;
    }
    record.claim = { ...record.claim, error: String(error?.message ?? error) };
    throw error;
  }
  delete record.claim.error;
  record.claim = { ...record.claim, status: status.type };
  switch (status.type) {
    case "claimed":
      if (status.finalized) {
        const credited = asBig(record.claim.credited) + asBig(record.claim.amount);
        record.claim = {
          ...record.claim,
          phase: "claimed",
          credited: credited.toString(),
          amount: credited.toString(),
          at: Date.now(),
        };
      }
      return;
    case "claimedPartially":
      record.claim = {
        ...record.claim,
        credited: (asBig(record.claim.credited) + status.actualClaimed).toString(),
      };
      settleShort(record);
      return;
    case "notClaimed":
      settleShort(record);
      return;
  }
}

/** The host is done with this attempt and the burner may still hold CASH: try again or settle. */
function settleShort(record) {
  if (record.claim.attempt + 1 < MAX_CLAIM_ATTEMPTS) {
    record.claim = nextAttempt(record.claim);
    return;
  }
  settleOnCredited(record);
}

/** The next attempt's marker; the burner is sized again on the following tick. */
const nextAttempt = (claim) => ({
  phase: "sizing",
  attempt: claim.attempt + 1,
  credited: claim.credited,
  at: 0,
  attempts: 0,
});

/** Nothing more will be registered: what the host minted is the claim, or there was none. */
function settleOnCredited(record) {
  const credited = record.claim.credited ?? "0";
  if (asBig(credited) > 0n) {
    record.claim = {
      ...record.claim,
      phase: "claimed",
      amount: credited,
      partial: true,
      at: Date.now(),
    };
    return;
  }
  fail(record, "claim", "the host claimed no CASH from the burner");
}

/** Rough progress percentage per phase, for display. */
const PHASE_PERCENT = {
  starting: 2,
  "await-native": 8,
  swap: 35,
  "await-arrival": 85,
  done: 100,
  failed: 0,
};

function describeFunding(record) {
  return {
    v: RECORD_V,
    sessionId: record.sessionId,
    phase: record.phase,
    done: record.done,
    percent: PHASE_PERCENT[record.phase] ?? 0,
    settleAmount: record.settleAmount,
    createdAt: record.createdAt,
    lastTickAt: record.lastTickAt,
    lastError: record.lastError,
    failure: record.failure,
    submitting: record.submitting,
    txs: record.txs,
    fundsSeenAt: record.state?.fundsSeenAt ?? null,
    claim: record.claim ?? null,
  };
}

/** Reads one job by `sessionId`, or all jobs. */
export async function fundingStatus(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const sessionId = String(input.sessionId ?? "");
  if (sessionId) {
    const record = all[sessionId];
    return record ? describeFunding(record) : { sessionId, known: false };
  }
  return { jobs: Object.values(all).map(describeFunding) };
}

const hostOwnsClaim = (record) => record.claim?.phase === "claiming";

/** True from the first tick that saw funds until the claim is registered with the host. */
const onTheClock = (record) =>
  !isFinished(record) &&
  !hostOwnsClaim(record) &&
  (record.done || record.state.fundsSeenAt !== null);

/** Adds this tick's gap, capped at MAX_TICK_GAP_MS, to the job's worked time while on the clock. */
function accountWorkedTime(record, nowMs) {
  const previous = record.lastTickAt;
  record.lastTickAt = nowMs;
  if (previous === null || !onTheClock(record)) return;
  const gap = Math.min(Math.max(nowMs - previous, 0), MAX_TICK_GAP_MS);
  record.state.workedMs = (record.state.workedMs ?? 0) + gap;
}

/**
 * Fails a job over the run bound, past the claim's tracking window, or past the deposit window
 * when this tick read the chain. Called after the tick.
 */
function judgeBounds(record, nowMs, read) {
  if (record.phase === "failed") return;
  if (onTheClock(record) && (record.state.workedMs ?? 0) > RUN_TIMEOUT_MS) {
    const what = record.done ? "claim" : "conversion";
    fail(record, "timeout", `${what} exceeded ${RUN_TIMEOUT_MS}ms of worker time`);
    return;
  }
  if (hostOwnsClaim(record) && nowMs - record.claim.registeredAt > CLAIM_TRACK_WINDOW_MS) {
    fail(record, "timeout", `the host has not settled the claim within ${CLAIM_TRACK_WINDOW_MS}ms`);
    return;
  }
  // The rail's deadline when the surface passed one, the default window otherwise.
  const armedAt = record.armedAt ?? record.createdAt;
  const expiresAt = record.depositExpiresAt ?? armedAt + DEPOSIT_WINDOW_MS;
  const waitingForDeposit = !record.done && record.state.fundsSeenAt === null;
  if (read && waitingForDeposit && nowMs > expiresAt) {
    fail(record, "expired", "no deposit arrived within the deposit window");
  }
}

/** One tick for one record: connect, read the world, act at most once, persist, let go. */
async function tickRecord(record, nowMs) {
  accountWorkedTime(record, nowMs);
  // The tier is an input to this worker, never a decision it makes: a job converts through the
  // route it was quoted or not at all.
  const route = recordedRoute(record);
  const burner = await keypairFor(record.label);
  const ahClient = await connectChain(record.assetHubGenesis, "asset hub");
  let peopleClient = null;
  try {
    peopleClient = await connectChain(record.peopleGenesis, "people");
    const peoplePort = createPeopleChainPort({ client: peopleClient });
    if (record.done) {
      await claimFor(record, burner, peoplePort);
      return;
    }
    const api = ahClient.getTypedApi(paseo_next_v2);
    // Pool keys are re-discovered each wake and not persisted. The PSM tier has no pool to find.
    const pool =
      route.tier === "pool"
        ? await bounded(
            discoverPool(api, record.underlyingAssetId),
            DEFAULT_TICK_TIMEOUT_MS,
            "pool discovery",
          )
        : undefined;

    // Restore the persisted state into the shape tickOnce mutates. fundsSeenAt must be
    // exactly null when absent.
    const state = freshTickState();
    state.attempts = record.state.attempts;
    state.psmRefusals = record.state.psmRefusals ?? 0;
    state.xcmSubmitted = !!record.state.xcmSubmitted;
    state.peopleAtXcm = asBig(record.state.peopleAtXcm);
    state.fundsSeenAt = record.state.fundsSeenAt ?? null;

    let outcome;
    try {
      outcome = await tickOnce(
        {
          api,
          peopleApi: peopleClient.getTypedApi(paseo_people_next),
          route,
          pool,
          address: burner.address,
          signer: burner.signer,
          beneficiaryHex: toHex(burner.publicKey),
          settleAmount: asBig(record.settleAmount),
          peopleParaId: record.peopleParaId,
          // The Asset Hub this worker is built for, the same one CASH_SETTLEMENT points at.
          assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
          remoteFeeBuffer: asBig(record.remoteFeeBuffer, DEFAULT_REMOTE_FEE_BUFFER),
          keepNativeForFees: asBig(record.keepNativeForFees, DEFAULT_KEEP_NATIVE_FOR_FEES),
          slippagePct: record.slippagePct,
          ...(typeof record.quotedDeposit === "string"
            ? { quotedDeposit: asBig(record.quotedDeposit) }
            : {}),
          tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
          submitTimeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS,
          // Every submit is on Asset Hub; one anchor per tick serves them all. The PSM tier adds
          // its fee asset itself.
          signOptions: await signOptionsFor(ahClient),
          readUnderlyingOnPeople: (ss58) => peoplePort.settlementBalance(ss58, CASH_SETTLEMENT),
          now: Date.now,
          // Persisted before the broadcast leaves.
          onBeforeSubmit: async (call) => {
            record.submitting = { call, at: Date.now() };
            await saveJobs();
          },
          onTx: (info) => {
            delete record.submitting;
            record.txs.push(info);
          },
        },
        state,
      );
    } finally {
      // Write the state back even when the tick threw; tickOnce mutates it as it works.
      record.state = {
        attempts: state.attempts,
        psmRefusals: state.psmRefusals,
        xcmSubmitted: state.xcmSubmitted,
        peopleAtXcm: state.peopleAtXcm.toString(),
        fundsSeenAt: state.fundsSeenAt,
        workedMs: record.state.workedMs ?? 0,
      };
    }
    // A cancel that landed during this tick stands.
    if (record.phase === "failed") return;
    record.phase = outcome.step;
    delete record.lastError;
    // A completed tick clears any stale submitting marker.
    delete record.submitting;
    if (outcome.step === "done") {
      record.done = true;
      // Claim in the same tick the CASH lands.
      await claimFor(record, burner, peoplePort);
    }
  } finally {
    try {
      peopleClient?.destroy();
    } finally {
      ahClient.destroy();
    }
  }
}

// A pass already running answers a second entry with "busy".
let ticking = false;

/**
 * Drives every live job one tick. Per-job errors are recorded on the job and contained.
 * A job ends only through `fail`; a re-sent hand-off re-arms it.
 */
export async function tickAllFunding() {
  if (ticking) return { ticked: 0, busy: true };
  ticking = true;
  try {
    const all = await loadJobs();
    // A job is live until claimed.
    const live = Object.values(all).filter(
      (record) => record?.v === RECORD_V && !isFinished(record) && record.phase !== "failed",
    );
    let ticked = 0;
    for (const record of live) {
      if (record.phase === "failed") continue; // cancelled since this pass began
      const nowMs = Date.now();
      let read = false;
      try {
        await tickRecord(record, nowMs);
        read = true;
      } catch (error) {
        if (error instanceof FundingShortfallError) {
          fail(record, "shortfall", `shortfall: ${error.message}`);
        } else if (error instanceof FundingHeldError) {
          // The PSM would not take the mint three times over. The deposit stays on the burner
          // and nothing converts it through the pool; a re-sent hand-off tries again.
          fail(record, "held", error.message);
        } else {
          // Other errors are transient; the next wake retries.
          record.lastError = String(error?.message ?? error);
        }
      }
      judgeBounds(record, nowMs, read);
      ticked += 1;
      await saveJobs();
    }
    return { ticked, busy: false };
  } finally {
    ticking = false;
  }
}
