import { followTopUpStatus, registerTopUp } from "./host.js";
import { toSchnorrkelSecret } from "@getsome/ephemeral";
import {
  DEFAULT_INCLUSION_TIMEOUT_MS,
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_SLIPPAGE_PCT,
  DEFAULT_TICK_TIMEOUT_MS,
  DEFAULT_REMOTE_FEE_BUFFER,
  FundingHeldError,
  FundingShortfallError,
  FundingTrappedError,
  PASEO_ASSET_HUB_PARA_ID,
  STABLE_TOKENS,
  chooseCashTransfer,
  chooseRoute,
  discoverPool,
  discoverPools,
  findRecoveryDeposit,
  freshRecoveryState,
  freshTickState,
  readDeposit,
  recordedRoute,
  recoveryCandidates,
  recoveryMinimums,
  tickOnce,
  tickRecovery,
} from "@getsome/funding";
import { CASH_SETTLEMENT, createPeopleChainPort } from "@getsome/people";
import { PaymentTopUpErr, PaymentTopUpStatusErr } from "@novasamatech/host-api";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { readParams } from "./params.js";
import {
  anchorFor,
  asBig,
  bounded,
  connectChain,
  createJobStore,
  fromHex,
  keypairFor,
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
 *   quotedDeposit?,                                    // psm, stable pool and dotUSD tiers
 *   underlyingAssetId, peopleParaId, assetHubGenesis, peopleGenesis,
 *   tier: "pool" | "psm" | "dotusd", external?, feeRate?, // the conversion route the surface
 *                                            // decided at quote time; consumed here, never
 *                                            // re-decided
 *   quoteFloorPct?, claimIdOffset?,          // a burner that is another job's key, sent home
 *                                            // whole: its exchange held to the pool's quote,
 *                                            // its claims under ids that key never used
 *   phase: "starting" | FundingStep | "recovering" | "failed",
 *                                            // await-native: the route's deposit asset
 *                                            // recovering: the CASH is in People's trap and
 *                                            // the burner is claiming it back
 *   failure?: "shortfall" | "timeout" | "expired" | "cancelled" | "claim" | "held",
 *                                            // held: the PSM refused the mint three times; the
 *                                            // deposit stays on the burner
 *   trap?: { amount: string, key, claimerHex, at },
 *                                            // the trap the program left on People: the CASH it
 *                                            // holds, the key AssetTraps counts it under, the
 *                                            // burner as the claimer it names
 *   recovery?: { phase: "funding"|"claiming"|"done", feeCash: string|null, askCash: string|null,
 *                attempts, nonceAtClaim: number|null, sentAt: number|null,
 *                minimums?: { at, feeCash, minimums: { PAS, DOTUSD, USDT, USDC }, keepNativeForFees,
 *                             routes: { USDT, USDC } },
 *                route?, state?, deposit? },
 *                                            // the claim's progress: funding while the burner
 *                                            // waits for the fee, claiming while a claim is
 *                                            // owed an answer; feeCash the fee with the margin,
 *                                            // askCash the same rounded up to the claim unit,
 *                                            // what the purse is asked for
 *                                            // minimums: the manual path's figures, the least
 *                                            // of each token to send to the burner on Asset Hub
 *                                            // (strings, null where unpriced) and each stable's
 *                                            // route; route, state, deposit: the recovery
 *                                            // deposit's route once one arrived, its pipeline
 *                                            // state, and the step its last tick reached
 *   done, createdAt, armedAt, lastTickAt, lastError?,
 *   state: { attempts, psmRefusals, xcmSubmitted, peopleAtXcm: string,
 *            fundsSeenAt: number|null, nonceAtSubmit: number|null,
 *            inclusionBlock: number|null, sentToPeople: string|null,
 *            workedMs, rejections, lastRejection },
 *                                            // sentToPeople: the CASH the submitted program
 *                                            // sends, what a trap of it holds
 *                                            // attempts: submits so far
 *                                            // psmRefusals: PSM refusals so far, not transport
 *                                            // nonceAtSubmit: set from before a submit until
 *                                            // the conversion is final
 *                                            // inclusionBlock: the block the conversion was
 *                                            // seen in, while it is not final
 *                                            // workedMs: worker time since the deposit was
 *                                            // final, until the claim is registered (see
 *                                            // accountWorkedTime)
 *                                            // rejections, lastRejection: paid rejections in
 *                                            // a row with the same answer
 *   submitting?: { call: "swap"|"claim", at }, // written before a submit, with the state
 *   txs: [{ call, txHash, block? }],
 *   depositSeen?: { block, finalizedAtSeen, finalized, best },
 *                                            // the deposit in a best block, followed until the
 *                                            // pipeline sees it final: block: the best block it
 *                                            // was first seen in; finalizedAtSeen: the finalized
 *                                            // block number then; finalized and best: at the
 *                                            // last tick
 *   conversion?: { preparedAt, converted?: { txHash, block, at, workedMs } },
 *                                            // preparedAt: the first submit past its dry run
 *                                            // converted: the latest submit in a best block that
 *                                            // succeeded and carried the tier's conversion event,
 *                                            // with the worker time then
 *   claim?: { phase: "sizing"|"registering"|"claiming"|"claimed", attempt, credited,
 *             id?, amount?, at, attempts, registeredAt?, workedMs?, status?, partial?, error? },
 *                                            // attempt: 0-based; each has its own id (hex)
 *                                            // credited: CASH the host minted so far
 *                                            // workedMs: worker time since this attempt was
 *                                            // registered
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
  const quoteFloorPct = input.quoteFloorPct === undefined ? undefined : Number(input.quoteFloorPct);
  if (quoteFloorPct !== undefined && !(quoteFloorPct >= 0 && quoteFloorPct < 100)) {
    throw new Error("startFunding: quoteFloorPct must be a percentage below 100");
  }
  const claimIdOffset = input.claimIdOffset === undefined ? 0 : Number(input.claimIdOffset);
  if (
    !Number.isInteger(claimIdOffset) ||
    claimIdOffset < 0 ||
    claimIdOffset > MAX_CLAIM_ID_OFFSET
  ) {
    throw new Error(
      `startFunding: claimIdOffset must be a whole number up to ${MAX_CLAIM_ID_OFFSET}`,
    );
  }
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
    ...(quoteFloorPct === undefined ? {} : { quoteFloorPct }),
    ...(claimIdOffset === 0 ? {} : { claimIdOffset }),
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
  nonceAtSubmit: null,
  inclusionBlock: null,
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
 * tracking window restart. Submit latches survive except after a shortfall; the rejection count
 * starts over; a held job gets a fresh refusal counter, for a ceiling raised since; a claim that
 * was still registering is retried at once, and a claim the host settled short gets a fresh
 * attempt.
 */
function rearm(record, nowMs) {
  record.phase = record.done ? "done" : record.trap ? "recovering" : "starting";
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
    record.state.nonceAtSubmit = null;
    record.state.inclusionBlock = null;
    record.state.sentToPeople = null;
  }
  if (failure === "held") record.state.psmRefusals = 0;
  record.state.rejections = 0;
  record.state.lastRejection = null;
  if (record.claim?.phase === "registering") {
    record.claim = { ...record.claim, attempts: 0, at: 0 };
  }
  if (record.claim?.phase === "claiming") {
    record.claim =
      failure === "claim"
        ? nextAttempt(record.claim)
        : { ...record.claim, registeredAt: nowMs, workedMs: 0 };
  }
}

function fail(record, failure, reason) {
  record.phase = "failed";
  record.failure = failure;
  record.lastError = reason;
  unwatchClaim(record.sessionId);
}

/** The program left the CASH in People's trap. The job turns into its recovery: the trap is
 *  recorded for the claim and for the surface, and the conversion's clock stops. */
function trapped(record, error, nowMs) {
  record.phase = "recovering";
  record.trap = {
    amount: error.amount.toString(),
    key: error.key,
    claimerHex: error.claimerHex,
    at: nowMs,
  };
  delete record.lastError;
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
  if (waitingForDeposit(record) && record.phase !== "failed") {
    fail(record, "cancelled", "cancelled by the surface");
    await saveJobs();
  }
  return describeFunding(record);
}

/**
 * New terms for a job still waiting for its deposit, from a re-sent hand-off: the settle amount,
 * the route and the figures the gate reads. A direct deposit that arrived short or in another
 * token is continued this way. Refused once the worker has seen funds or submitted anything, for
 * another burner, and for a job that has ended; the burner, the label and the run's own state
 * stay as they were.
 */
export async function amendFunding(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const record = all[String(input.sessionId ?? "")];
  if (!record) return { error: "invalid", reason: "no such job to amend" };
  const mismatch = await burnerMismatch(record, String(input.burnerAddress ?? ""));
  if (mismatch) return { error: "invalid", reason: mismatch };
  const waiting =
    !record.done &&
    record.phase !== "failed" &&
    record.state.fundsSeenAt === null &&
    !record.state.xcmSubmitted &&
    record.submitting === undefined;
  if (!waiting) return { error: "invalid", reason: "the job is no longer waiting for its deposit" };
  let terms;
  try {
    // The same checks a new hand-off gets, route included.
    terms = newRecord({ ...input, label: record.label }, Date.now());
  } catch (error) {
    return { error: "invalid", reason: String(error?.message ?? error) };
  }
  for (const field of ["tier", "external", "feeRate", "quotedDeposit"]) delete record[field];
  Object.assign(record, {
    settleAmount: terms.settleAmount,
    remoteFeeBuffer: terms.remoteFeeBuffer,
    keepNativeForFees: terms.keepNativeForFees,
    slippagePct: terms.slippagePct,
    ...(terms.quotedDeposit === undefined ? {} : { quotedDeposit: terms.quotedDeposit }),
    ...recordedRoute(terms),
  });
  await saveJobs();
  return describeFunding(record);
}

/** True while the funding leg waits for a deposit the pipeline has not yet seen final. */
const waitingForDeposit = (record) => !record.done && record.state.fundsSeenAt === null;

/** True once the CASH has landed and been claimed; `done` alone means the funding leg is over. */
const isFinished = (record) => record.done === true && record.claim?.phase === "claimed";

/** The burner's CASH on People in the finalized block, floored to the claim unit. */
async function claimableOn(peoplePort, burner, what) {
  const held = await bounded(
    peoplePort.settlementBalance(burner.address, CASH_SETTLEMENT, { at: "finalized" }),
    DEFAULT_TICK_TIMEOUT_MS,
    what,
  );
  return (held / CLAIM_UNIT) * CLAIM_UNIT;
}

/**
 * Claims are multiples of 0.01 CASH (6 decimals): the coinage instance's asset unit, so a
 * registered amount is exactly what the host can mint.
 */
export const CLAIM_UNIT = 10_000n;
/** Timeout for one host top-up call. */
const CLAIM_TIMEOUT_MS = 45_000;
/** Minimum wait before a failed registration is retried. */
const CLAIM_RETRY_MS = 180_000;
/** Time a registered claim may stay unsettled on the host before the job is failed. */
const CLAIM_TRACK_WINDOW_MS = 5_400_000;
/** Registrations a job makes on its own before it settles for what the host credited. */
const MAX_CLAIM_ATTEMPTS = 3;
/** The largest `claimIdOffset`: it leaves room above for every attempt a job can make, inside
 *  the 32-bit counter an attempt's id is derived with. */
const MAX_CLAIM_ID_OFFSET = 2 ** 31;
/** Bound on a trap claim reaching finality on People; past it a later tick settles from the
 *  trap's count what became of it. */
const RECOVERY_SUBMIT_TIMEOUT_MS = 120_000;

/** The id claim attempt `attempt` is registered under. A burner that is another job's key starts
 *  its attempts at an offset, so no claim takes an id that key was already paid under. */
const claimIdFor = (record, burner, attempt) =>
  topUpIdFor(burner.publicKey, (record.claimIdOffset ?? 0) + attempt);

/**
 * Claims the burner's CASH into the purse once the funding leg is done. Each attempt sizes the
 * burner, registers that amount with the host under an id derived from the burner's public key,
 * and follows the top-up's status, as the host pushes it, to its terminal value; the host drives
 * it from registration on. A top-up the host settles short leaves CASH on the burner, and the
 * next attempt claims it. The `registering` marker is written before the call, so a wake that
 * finds it re-registers, and `AlreadyExists` counts as registered. Only sizing reads a chain.
 */
async function claimFor(record) {
  const claim = record.claim ?? null;
  if (claim?.phase === "claimed") return;
  if (claim?.phase === "claiming") {
    watchClaim(record);
    return;
  }
  if (claim?.phase === "registering") {
    if (Date.now() - claim.at < CLAIM_RETRY_MS) return;
    await registerClaim(record, await keypairFor(record.label));
    return;
  }
  const burner = await keypairFor(record.label);
  const peopleClient = await connectChain(record.peopleGenesis, "people");
  try {
    await sizeClaim(record, burner, createPeopleChainPort({ client: peopleClient }));
  } finally {
    peopleClient.destroy();
  }
}

/** Sizes the burner on People and registers the attempt for what it holds, or settles. */
async function sizeClaim(record, burner, peoplePort) {
  const amount = await claimableOn(peoplePort, burner, "burner CASH read");
  const claim = record.claim ?? null;
  if (amount === 0n) {
    if (claim?.phase === "sizing") settleOnCredited(record);
    return;
  }
  const attempt = claim?.attempt ?? 0;
  record.claim = {
    phase: "registering",
    attempt,
    credited: claim?.credited ?? "0",
    id: toHex(claimIdFor(record, burner, attempt)),
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
        claimIdFor(record, burner, record.claim.attempt),
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
  record.claim = { ...record.claim, phase: "claiming", registeredAt: Date.now(), workedMs: 0 };
  watchClaim(record);
}

/** The status subscriptions held open, one per claiming job: `{ id, stop }` by session id. */
const claimWatches = new Map();

/**
 * Follows the claim's current attempt on the host until it ends. The host replays the latest
 * status on subscribe, so a watch opened late, after a restart or an interrupt, misses nothing.
 */
function watchClaim(record) {
  const { sessionId } = record;
  const { id } = record.claim;
  if (claimWatches.get(sessionId)?.id === id) return;
  unwatchClaim(sessionId);
  // A word about an attempt that is no longer the live one is ignored.
  const live = () =>
    record.phase !== "failed" && record.claim?.phase === "claiming" && record.claim.id === id;
  const stop = followTopUpStatus(
    fromHex(id),
    (status) => {
      if (!live()) return;
      applyClaimStatus(record, status);
      if (!live()) unwatchClaim(sessionId);
      void saveJobs();
    },
    (error) => {
      if (!live()) return;
      unwatchClaim(sessionId);
      if (error instanceof PaymentTopUpStatusErr.NotFound) {
        record.claim = { ...record.claim, phase: "registering", at: 0 };
      } else {
        record.claim = { ...record.claim, error: String(error?.message ?? error) };
        record.lastError = record.claim.error;
      }
      void saveJobs();
    },
  );
  claimWatches.set(sessionId, { id, stop });
}

function unwatchClaim(sessionId) {
  claimWatches.get(sessionId)?.stop();
  claimWatches.delete(sessionId);
}

/** Applies one status the host reported for the claim's current attempt. */
function applyClaimStatus(record, status) {
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
    workedMs: record.state?.workedMs ?? 0,
    lastError: record.lastError,
    failure: record.failure,
    trap: record.trap,
    recovery: record.recovery,
    submitting: record.submitting,
    txs: record.txs,
    fundsSeenAt: record.state?.fundsSeenAt ?? null,
    depositSeen: record.depositSeen ?? null,
    conversion: record.conversion ?? null,
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

/** True from the first tick that saw funds until the claim is registered with the host. A
 *  recovery waits on the buyer and on People, not on this worker, so its ticks are not worked
 *  time: the clock stops at the trap and resumes with the claim. */
const onTheClock = (record) =>
  !isFinished(record) &&
  !hostOwnsClaim(record) &&
  record.phase !== "recovering" &&
  (record.done || record.state.fundsSeenAt !== null);

/**
 * Adds this tick's gap, capped at MAX_TICK_GAP_MS, to the job's worked time while on the clock, or
 * to the claim's while the host owns it.
 */
function accountWorkedTime(record, nowMs) {
  const previous = record.lastTickAt;
  record.lastTickAt = nowMs;
  if (previous === null) return;
  const gap = Math.min(Math.max(nowMs - previous, 0), MAX_TICK_GAP_MS);
  if (onTheClock(record)) {
    record.state.workedMs = (record.state.workedMs ?? 0) + gap;
  } else if (hostOwnsClaim(record)) {
    record.claim = { ...record.claim, workedMs: (record.claim.workedMs ?? 0) + gap };
  }
}

/**
 * Fails a job over the run bound, past the claim's tracking window, or past the deposit window
 * when this tick read the chain. Called after the tick.
 */
function judgeBounds(record, nowMs, read) {
  if (record.phase === "failed") return;
  // A trap never expires, and neither does the recovery of one; once claimed back, the job is
  // on the host's clock as any other.
  if (record.phase === "recovering") return;
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
  if (read && waitingForDeposit(record) && nowMs > expiresAt) {
    fail(record, "expired", "no deposit arrived within the deposit window");
  }
}

/** One tick for one record: read what it needs, act at most once, persist, let go. */
async function tickRecord(record, nowMs) {
  accountWorkedTime(record, nowMs);
  if (record.done) {
    await claimFor(record);
    return;
  }
  const burner = await keypairFor(record.label);
  const ahClient = await connectChain(record.assetHubGenesis, "asset hub");
  let peopleClient = null;
  try {
    peopleClient = await connectChain(record.peopleGenesis, "people");
    const env = {
      burner,
      ahClient,
      peopleClient,
      api: ahClient.getTypedApi(paseo_next_v2),
      peopleApi: peopleClient.getTypedApi(paseo_people_next),
      peoplePort: createPeopleChainPort({ client: peopleClient }),
    };
    // The CASH is in People's trap: the conversion is over and the recovery has the job.
    if (record.trap) {
      await recoverTrapped(record, env);
      return;
    }
    await convert(record, env);
  } finally {
    try {
      peopleClient?.destroy();
    } finally {
      ahClient.destroy();
    }
  }
}

/** The job's own conversion: the deposit the surface quoted, through the route it recorded. */
async function convert(record, env) {
  // The tier is an input to this worker, never a decision it makes: a job converts through the
  // route it was quoted or not at all.
  const route = recordedRoute(record);
  const outcome = await runConversion(record, env, {
    route,
    settleAmount: asBig(record.settleAmount),
    remoteFeeBuffer: asBig(record.remoteFeeBuffer, DEFAULT_REMOTE_FEE_BUFFER),
    keepNativeForFees: asBig(record.keepNativeForFees, DEFAULT_KEEP_NATIVE_FOR_FEES),
    slippagePct: record.slippagePct,
    ...(typeof record.quotedDeposit === "string"
      ? { quotedDeposit: asBig(record.quotedDeposit) }
      : {}),
    ...(typeof record.quoteFloorPct === "number" ? { quoteFloorPct: record.quoteFloorPct } : {}),
    followDeposit: true,
    stored: record.state,
    store: (state) => {
      record.state = { ...state, workedMs: record.state.workedMs ?? 0 };
    },
    onConversion: (fact) => recordConversion(record, fact),
  });
  // A cancel that landed during this tick stands.
  if (record.phase === "failed") return;
  record.phase = outcome.step;
  delete record.lastError;
  // A completed tick clears any stale submitting marker.
  delete record.submitting;
  if (outcome.step === "done") {
    record.done = true;
    // Claim in the same tick the CASH lands, over this tick's People connection.
    await sizeClaim(record, env.burner, env.peoplePort);
  }
}

/** The persisted shape of a TickState, bigints as strings. */
function restoreTickState(stored) {
  // fundsSeenAt must be exactly null when absent.
  const state = freshTickState();
  state.attempts = stored.attempts ?? 0;
  state.psmRefusals = stored.psmRefusals ?? 0;
  state.rejections = stored.rejections ?? 0;
  state.lastRejection = stored.lastRejection ?? null;
  state.xcmSubmitted = !!stored.xcmSubmitted;
  state.peopleAtXcm = asBig(stored.peopleAtXcm);
  state.fundsSeenAt = stored.fundsSeenAt ?? null;
  state.nonceAtSubmit = stored.nonceAtSubmit ?? null;
  state.inclusionBlock = stored.inclusionBlock ?? null;
  state.sentToPeople = stored.sentToPeople == null ? null : asBig(stored.sentToPeople);
  state.peopleFeeCash = stored.peopleFeeCash == null ? null : asBig(stored.peopleFeeCash);
  return state;
}

function storeTickState(state) {
  return {
    attempts: state.attempts,
    psmRefusals: state.psmRefusals,
    rejections: state.rejections,
    lastRejection: state.lastRejection,
    xcmSubmitted: state.xcmSubmitted,
    peopleAtXcm: state.peopleAtXcm.toString(),
    fundsSeenAt: state.fundsSeenAt,
    nonceAtSubmit: state.nonceAtSubmit,
    inclusionBlock: state.inclusionBlock,
    sentToPeople: state.sentToPeople === null ? null : state.sentToPeople.toString(),
    peopleFeeCash: state.peopleFeeCash === null ? null : state.peopleFeeCash.toString(),
  };
}

/**
 * One pipeline tick over the burner: the job's own conversion, or a recovery deposit converted
 * for the claim's fee. `job` names the route and the target; the state it restores and stores is
 * the job's, written back before a submit leaves and after the tick, thrown or not.
 */
async function runConversion(record, env, job) {
  const { api, ahClient, peopleClient, peoplePort, burner } = env;
  const { route } = job;
  // Pool keys are re-discovered each wake and not persisted, in one read of the pool table: the
  // CASH pool, and for a pool job fed with a stable the stable's own pool too, under its
  // pallet-assets id. The PSM and dotUSD tiers have no pool to find.
  const [pool, stablePool] =
    route.tier === "pool"
      ? await bounded(
          discoverPools(
            api,
            route.external === undefined
              ? [record.underlyingAssetId]
              : [record.underlyingAssetId, STABLE_TOKENS[route.external].assetHubId],
          ),
          DEFAULT_TICK_TIMEOUT_MS,
          "pool discovery",
        )
      : [];
  // Asked on every dispatch, so a runtime upgrade between ticks is picked up before the next
  // submit; a network with no transfer fails the tick like any other read.
  const transfer = await bounded(
    chooseCashTransfer({
      assetHub: ahClient,
      people: peopleClient,
      assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
      peopleParaId: record.peopleParaId,
    }),
    DEFAULT_TICK_TIMEOUT_MS,
    "cash transfer choice",
  );
  // Every submit is on Asset Hub; one anchor per tick serves them all.
  const anchor = await anchorFor(ahClient);
  if (job.followDeposit && waitingForDeposit(record)) {
    await followDeposit(record, api, route, burner.address, anchor);
  }

  const state = restoreTickState(job.stored ?? {});
  const persistState = () => job.store(storeTickState(state));
  let outcome;
  try {
    outcome = await tickOnce(
      {
        api,
        peopleApi: env.peopleApi,
        route,
        transfer,
        pool,
        stablePool,
        address: burner.address,
        signer: burner.signer,
        beneficiaryHex: toHex(burner.publicKey),
        settleAmount: job.settleAmount,
        remoteFeeBuffer: job.remoteFeeBuffer,
        peopleParaId: record.peopleParaId,
        // The Asset Hub this worker is built for, the same one CASH_SETTLEMENT points at.
        assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
        keepNativeForFees: job.keepNativeForFees,
        slippagePct: job.slippagePct,
        ...(job.quotedDeposit === undefined ? {} : { quotedDeposit: job.quotedDeposit }),
        ...(job.quoteFloorPct === undefined ? {} : { quoteFloorPct: job.quoteFloorPct }),
        tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
        inclusionTimeoutMs: DEFAULT_INCLUSION_TIMEOUT_MS,
        // The PSM tier adds its fee asset itself.
        signOptions: { at: anchor.hash },
        readFinalizedUnderlyingOnPeople: (ss58) =>
          peoplePort.settlementBalance(ss58, CASH_SETTLEMENT, { at: "finalized" }),
        now: Date.now,
        // Persisted before the broadcast leaves, so a wake mid-send knows a conversion may be
        // in flight.
        onBeforeSubmit: async (call) => {
          persistState();
          record.submitting = { call, at: Date.now() };
          await saveJobs();
        },
        onTx: (info) => {
          delete record.submitting;
          record.txs.push(info);
        },
        ...(job.onConversion === undefined ? {} : { onConversion: job.onConversion }),
      },
      state,
    );
  } finally {
    persistState();
  }
  return outcome;
}

/**
 * Follows the deposit while the pipeline waits for it to be final: it reads the burner at the
 * anchor until the deposit shows there, then only moves the finalized block number on. The
 * pipeline decides on the finalized deposit alone.
 */
async function followDeposit(record, api, route, address, anchor) {
  if (record.depositSeen) {
    record.depositSeen = {
      ...record.depositSeen,
      finalized: anchor.finalized,
      best: anchor.number,
    };
    return;
  }
  const held = await bounded(
    readDeposit(api, route, address, anchor.hash),
    DEFAULT_TICK_TIMEOUT_MS,
    "deposit read (best)",
  );
  if (held === 0n) return;
  record.depositSeen = {
    block: anchor.number,
    finalizedAtSeen: anchor.finalized,
    finalized: anchor.finalized,
    best: anchor.number,
  };
}

/** `amount` rounded up to the claim unit: the least the host can pay that covers it. */
const roundUpToClaimUnit = (amount) => ((amount + CLAIM_UNIT - 1n) / CLAIM_UNIT) * CLAIM_UNIT;

/**
 * One recovery tick: the burner claims the trap back once it holds the claim's fee in CASH, and
 * the job is then done as any other, its CASH on the burner for the host's claim. While the fee
 * is missing, a deposit the user makes on the burner's Asset Hub account is converted for it.
 * The recovery's own fields are written back before a submit leaves and after the tick, thrown
 * or not; the rest of `record.recovery` is kept as it was.
 */
async function recoverTrapped(record, env) {
  const { burner, peoplePort } = env;
  record.phase = "recovering";
  const kept = record.recovery ?? {};
  const state = freshRecoveryState();
  state.feeCash = kept.feeCash == null ? null : asBig(kept.feeCash);
  state.round = kept.round ?? 0;
  state.held = kept.held == null ? null : asBig(kept.held);
  state.attempts = kept.attempts ?? 0;
  state.nonceAtClaim = kept.nonceAtClaim ?? null;
  state.claimSentAt = kept.sentAt ?? null;
  const persist = (phase) => {
    const fee = state.feeCash;
    // What the purse is asked for: the fee less what the burner already holds, in whole units;
    // the fee itself once the burner covers it.
    const owed = fee === null ? null : fee - (state.held ?? 0n);
    record.recovery = {
      ...record.recovery,
      phase,
      feeCash: fee === null ? null : fee.toString(),
      askCash: owed === null ? null : roundUpToClaimUnit(owed > 0n ? owed : fee).toString(),
      round: state.round,
      held: state.held === null ? null : state.held.toString(),
      attempts: state.attempts,
      nonceAtClaim: state.nonceAtClaim,
      sentAt: state.claimSentAt,
    };
  };
  let outcome;
  try {
    outcome = await tickRecovery(
      {
        peopleApi: env.peopleApi,
        address: burner.address,
        signer: burner.signer,
        claimerHex: record.trap.claimerHex,
        trap: { amount: asBig(record.trap.amount), key: record.trap.key },
        readCashOnPeople: (ss58, at) => peoplePort.settlementBalance(ss58, CASH_SETTLEMENT, { at }),
        tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
        submitTimeoutMs: RECOVERY_SUBMIT_TIMEOUT_MS,
        now: Date.now,
        onBeforeSubmit: async () => {
          persist("claiming");
          record.submitting = { call: "claim", at: Date.now() };
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
    persist(record.recovery?.phase ?? "funding");
    // The round moved on: a claim spent the fee, or the fee grew. Whatever deposit covered it is
    // over, and the next funding round looks for one afresh.
    if (state.round !== (kept.round ?? 0)) {
      delete record.recovery.route;
      delete record.recovery.state;
      delete record.recovery.deposit;
    }
  }
  delete record.lastError;
  delete record.submitting;
  persist(outcome.step);
  if (outcome.step === "done") {
    record.phase = "done";
    record.done = true;
    // Claim in the same tick the CASH is back, over this tick's People connection.
    await sizeClaim(record, burner, peoplePort);
    return;
  }
  if (outcome.step === "funding") await fundRecovery(record, env, state.feeCash);
}

/** How long the figures the manual path shows stand before they are priced again. */
const RECOVERY_MINIMUMS_TTL_MS = 10 * 60_000;

/**
 * The manual way to the claim's fee: the user sends any token a top-up takes to the burner's
 * Asset Hub account, and the pipeline converts it for the fee as it would a top-up. The least of
 * each token that clears the pipeline's gate is priced for the surface and kept fresh; the first
 * token held at or above its figure is the deposit, and its route is kept once chosen, as a job's
 * is. A failure here is this tick's and the next one tries again; the conversion's own terminal
 * answers are not the job's, since the trap stands whatever becomes of the deposit.
 */
async function fundRecovery(record, env, feeCash) {
  const { api, burner } = env;
  const recovery = record.recovery;
  const stale =
    recovery.minimums === undefined ||
    recovery.minimums.feeCash !== feeCash.toString() ||
    Date.now() - recovery.minimums.at > RECOVERY_MINIMUMS_TTL_MS;
  if (stale) {
    recovery.minimums = await sizeRecoveryMinimums(record, env, feeCash);
    await saveJobs();
  }
  const routes = {
    USDT: recordedRoute(recovery.minimums.routes.USDT),
    USDC: recordedRoute(recovery.minimums.routes.USDC),
  };
  const minimums = Object.fromEntries(
    Object.entries(recovery.minimums.minimums).map(([token, figure]) => [
      token,
      figure === null ? null : asBig(figure),
    ]),
  );
  let route = recovery.route === undefined ? null : recordedRoute(recovery.route);
  if (route === null) {
    const found = await bounded(
      findRecoveryDeposit(api, burner.address, recoveryCandidates(minimums, routes)),
      DEFAULT_TICK_TIMEOUT_MS,
      "recovery deposit read",
    );
    if (found === null) return;
    route = found.route;
    recovery.route = recordedRouteFields(route);
    await saveJobs();
  }
  let outcome;
  try {
    outcome = await runConversion(record, env, {
      route,
      settleAmount: feeCash,
      remoteFeeBuffer: DEFAULT_REMOTE_FEE_BUFFER,
      keepNativeForFees: asBig(recovery.minimums.keepNativeForFees, DEFAULT_KEEP_NATIVE_FOR_FEES),
      slippagePct: DEFAULT_SLIPPAGE_PCT,
      followDeposit: false,
      stored: recovery.state ?? {},
      store: (state) => {
        recovery.state = state;
      },
    });
  } catch (error) {
    // The conversion's own terminal answers end this deposit's attempt, not the recovery: the
    // route and the conversion's state are let go, so the next tick looks for a deposit afresh
    // and chooses its route again, and what ended it is kept for the surface. A deposit that
    // was itself trapped stays in People's trap, for governance.
    if (
      error instanceof FundingHeldError ||
      error instanceof FundingShortfallError ||
      error instanceof FundingTrappedError
    ) {
      recovery.depositError = { message: String(error.message), at: Date.now() };
      delete recovery.route;
      delete recovery.state;
      delete recovery.deposit;
    }
    throw new Error(`recovery deposit: ${String(error?.message ?? error)}`);
  }
  recovery.deposit = outcome.step;
  if (outcome.step === "done") {
    // The deposit is CASH on People: its conversion is over, and only the step is kept, for the
    // surface, until the claim. The route and the state are let go, so a funding round after
    // this one looks for a deposit afresh instead of replaying a finished conversion.
    delete recovery.route;
    delete recovery.state;
    delete recovery.depositError;
  }
}

/** The route's recorded fields, as a hand-off carries them. */
const recordedRouteFields = (route) => ({
  tier: route.tier,
  ...(route.external === undefined ? {} : { external: route.external }),
  ...(route.feeRate === undefined ? {} : { feeRate: route.feeRate }),
});

/** Prices the manual path for `feeCash`: each stable's route for it, then the least of each
 *  token, bigints as strings for the record. */
async function sizeRecoveryMinimums(record, env, feeCash) {
  const { api, ahClient, peopleClient, burner } = env;
  const read = (work, what) => bounded(work, DEFAULT_TICK_TIMEOUT_MS, what);
  const poolOf = (id) => discoverPool(api, id).catch(() => null);
  const [pool, usdtPool, usdcPool, transfer, usdtRoute, usdcRoute] = await read(
    Promise.all([
      poolOf(record.underlyingAssetId),
      poolOf(STABLE_TOKENS.USDT.assetHubId),
      poolOf(STABLE_TOKENS.USDC.assetHubId),
      chooseCashTransfer({
        assetHub: ahClient,
        people: peopleClient,
        assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
        peopleParaId: record.peopleParaId,
      }),
      chooseRoute(api, { direction: "mint", internalAmount: feeCash, deposit: "USDT" }),
      chooseRoute(api, { direction: "mint", internalAmount: feeCash, deposit: "USDC" }),
    ]),
    "recovery minimums reads",
  );
  const routes = { USDT: usdtRoute, USDC: usdcRoute };
  const sized = await read(
    recoveryMinimums({
      api,
      peopleParaId: record.peopleParaId,
      feeCash,
      transfer,
      beneficiaryHex: toHex(burner.publicKey),
      probeAddress: burner.address,
      pool,
      stablePools: {
        ...(usdtPool === null ? {} : { USDT: usdtPool }),
        ...(usdcPool === null ? {} : { USDC: usdcPool }),
      },
      routes,
    }),
    "recovery minimums",
  );
  return {
    at: Date.now(),
    feeCash: feeCash.toString(),
    minimums: Object.fromEntries(
      Object.entries(sized.minimums).map(([token, figure]) => [
        token,
        figure === null ? null : figure.toString(),
      ]),
    ),
    keepNativeForFees: sized.keepNativeForFees === null ? null : sized.keepNativeForFees.toString(),
    routes: { USDT: recordedRouteFields(usdtRoute), USDC: recordedRouteFields(usdcRoute) },
  };
}

/** Records the conversion's progress. A retry is prepared again; the first time stands. */
function recordConversion(record, fact) {
  const preparedAt = record.conversion?.preparedAt ?? Date.now();
  if (fact.type === "prepared") {
    record.conversion = { ...record.conversion, preparedAt };
    return;
  }
  const converted = {
    txHash: fact.txHash,
    block: fact.block,
    at: Date.now(),
    workedMs: record.state.workedMs ?? 0,
  };
  record.conversion = { ...record.conversion, preparedAt, converted };
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
        } else if (error instanceof FundingTrappedError) {
          trapped(record, error, nowMs);
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
