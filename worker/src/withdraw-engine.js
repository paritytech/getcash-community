import { CASH_LOCATION } from "@getsome/people";
import {
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  freshWithdrawTickState,
  PaymentUnresolvedError,
  readBurnerOnAssetHub,
  readDestinationPas,
  restoreWithdrawTickState,
  serialiseWithdrawTickState,
  withdrawTickOnce,
  WithdrawRejectedError,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { AccountId } from "polkadot-api";
import { readParams } from "./params.js";
import {
  asBig,
  bounded,
  connectChain,
  createJobStore,
  keypairFor,
  signOptionsFor,
} from "./shared.js";

// The withdrawal engine: the only driver of withdrawTickOnce, one tick per live job per pass.
//
// Once this engine holds a job it is the only writer for it. The surface only reads records back.
// Each dispatch runs at most one tick per live job, persists what it learned, and exits. Records
// carry the entropy label, never a secret; the key is re-derived on every wake. The engine never
// starts a payment: it watches the key the purse pays and moves what lands there.

/** Bump when the record shape changes; readers skip versions they don't know — and a skipped
 *  record is never ticked and never failed, so it becomes a job with funds on a burner that
 *  nobody is driving. The state is stored generically now, with bigints boxed, but
 *  `restoreWithdrawTickState` reads the older bare-string form too, so the shape did not have
 *  to break and this stays where it is. */
const RECORD_V = 1;

/** Storage key for the job map, keyed by session id. */
const WITHDRAW_KEY = "getsome.withdraw.jobs";

/** Worker time the conversion may take once the CASH is seen. */
const RUN_TIMEOUT_MS = 900_000;
/** A gap between ticks longer than this means the worker was not running in between. */
const MAX_TICK_GAP_MS = 30_000;
/** A job whose payment never arrives is retired after this when the hand-off names no window. */
const PAYMENT_WINDOW_MS = 1_800_000;

const store = createJobStore(WITHDRAW_KEY, "withdraw");
const loadJobs = () => store.load();
const saveJobs = () => store.save();
/** Throws when the write does not land. For state a broadcast must not outrun. */
const saveJobsStrict = () => store.saveStrict();

/**
 * One withdrawal job's record, as persisted between wakes.
 *
 * {
 *   v: 1, sessionId, label,                  // label: the entropy label the surface used
 *   keyAddress, keyPublicKeyHex,             // the key the surface showed and the purse pays
 *   amount, destination, landingHex, rail,   // what the surface asked for; kept for its records
 *   assetHubGenesis, peopleGenesis, peopleParaId, assetHubParaId, poolAccount, slippagePct,
 *   paymentExpiresAt: number|null,
 *   meld: { committedAmount, providerPayoutAddress, orderRef, meldFundingRequestId,
 *           quotedFiatAmount, quotedFiatCurrency, cryptoCurrency } | null,
 *                                           // only when rail is "meld": what turns into the
 *                                           // tick's WithdrawCommitment. Everything past
 *                                           // committedAmount/providerPayoutAddress is unused by
 *                                           // the tick itself and carried only so a surface that
 *                                           // lost its own record can rebuild the sale from this
 *                                           // job alone -- see recordFromWithdrawJob.
 *   phase: "starting" | WithdrawStep | "failed",
 *   failure?: "rejected" | "timeout" | "expired" | "cancelled" | "unresolved",
 *   done, createdAt, armedAt, lastTickAt, lastError?,
 *   state: { ...serialiseWithdrawTickState(tickState), workedMs },
 *                                           // every field of the tick state, bigints boxed as
 *                                           // { $bigint }, plus the engine's own workedMs
 *   submitting?: { call, at },               // written before a submit
 *   txs: [{ call, txHash, block? }],
 * }
 */
function newRecord(input, nowMs) {
  const sessionId = String(input.sessionId ?? "");
  const label = String(input.label ?? "");
  const keyAddress = String(input.keyAddress ?? "");
  const keyPublicKeyHex = String(input.keyPublicKeyHex ?? "");
  const landingHex = String(input.landingHex ?? "");
  const assetHubGenesis = String(input.assetHubGenesis ?? "");
  const peopleGenesis = String(input.peopleGenesis ?? "");
  const poolAccount = String(input.poolAccount ?? "");
  const peopleParaId = Number(input.peopleParaId);
  const assetHubParaId = Number(input.assetHubParaId);
  const slippagePct = Number(input.slippagePct);
  const destination = input.destination;
  if (!sessionId) throw new Error("startWithdraw: sessionId is required");
  if (!label) throw new Error("startWithdraw: the entropy label is required");
  if (!keyAddress || !/^0x[0-9a-f]{64}$/i.test(keyPublicKeyHex)) {
    throw new Error("startWithdraw: the surface's key address and public key are required");
  }
  if (!/^0x[0-9a-f]{64}$/i.test(landingHex)) {
    throw new Error("startWithdraw: the landing account must be a 32-byte hex");
  }
  if (!/^\d+$/.test(String(input.amount ?? "")) || asBig(input.amount) <= 0n) {
    throw new Error("startWithdraw: amount must be a positive integer string");
  }
  if (
    typeof destination !== "object" ||
    destination === null ||
    typeof destination.chain !== "string" ||
    typeof destination.asset !== "string" ||
    typeof destination.address !== "string"
  ) {
    throw new Error("startWithdraw: destination needs chain, asset and address");
  }
  if (input.rail !== "direct" && input.rail !== "chainflip" && input.rail !== "meld") {
    throw new Error("startWithdraw: rail must be direct, chainflip or meld");
  }
  if (!assetHubGenesis || !peopleGenesis) {
    throw new Error("startWithdraw: both chain genesis hashes are required");
  }
  if (!Number.isInteger(peopleParaId) || !Number.isInteger(assetHubParaId)) {
    throw new Error("startWithdraw: peopleParaId and assetHubParaId must be integers");
  }
  if (!poolAccount) throw new Error("startWithdraw: the pool account is required");
  if (!(slippagePct > 0)) throw new Error("startWithdraw: slippagePct must be positive");
  // An off-ramp's sale lands with no rail of its own to carry it onward; the meld object is what
  // turns into the tick's WithdrawCommitment, so it is validated as strictly as everything above,
  // and its absence on a meld rail must fail before a burner is ever watched.
  const meld = input.rail === "meld" ? meldFieldsOf(input.meld) : null;
  return {
    v: RECORD_V,
    sessionId,
    label,
    keyAddress,
    keyPublicKeyHex,
    amount: String(input.amount),
    destination: {
      chain: destination.chain,
      asset: destination.asset,
      address: destination.address,
    },
    landingHex,
    rail: input.rail,
    assetHubGenesis,
    peopleGenesis,
    peopleParaId,
    assetHubParaId,
    poolAccount,
    slippagePct,
    paymentExpiresAt: paymentExpiryOf(input),
    meld,
    phase: "starting",
    done: false,
    createdAt: nowMs,
    armedAt: nowMs,
    lastTickAt: null,
    state: freshRecordState(),
    txs: [],
  };
}

const accountId = AccountId();

/** A 32-byte account in any SS58 prefix. The same check `isAssetHubAddress` in
 *  app/withdraw/destinations.ts makes, duplicated rather than shared because the worker cannot
 *  import from `app/` -- it is a separate build target. */
function isAssetHubAddress(address) {
  try {
    return accountId.enc(String(address).trim()).length === 32;
  } catch {
    return false;
  }
}

/** Validates and normalises a meld rail's sale details. Every field is required: a commitment
 *  the tick can only half-act on -- an amount with no address to pay it to, say -- is worse than
 *  one refused outright, since the failure would otherwise surface mid-run instead of at the
 *  hand-off that could still be corrected.
 *
 *  `providerPayoutAddress` is decode-checked, not merely required non-empty like the fields that
 *  are only ever carried: it is the destination of an irreversible payment `payProvider` signs
 *  against, and a bad value reaching that point does not refuse -- it throws deep inside a dry
 *  run, which `tickAllWithdraw` treats as transient and retries forever, never even counting
 *  against `payAttempts`, since that only advances after a dry run has already passed. Both
 *  surface call sites canonicalise before this is ever reached, so this is defence in depth, not
 *  the only guard -- but it is the one that keeps a bad value from becoming an infinite retry
 *  instead of a refusal. */
function meldFieldsOf(meld) {
  if (typeof meld !== "object" || meld === null) {
    throw new Error("startWithdraw: a meld rail needs its sale details");
  }
  const committedAmount = String(meld.committedAmount ?? "");
  if (!/^\d+$/.test(committedAmount) || asBig(committedAmount) <= 0n) {
    throw new Error("startWithdraw: meld.committedAmount must be a positive integer string");
  }
  const strings = {
    providerPayoutAddress: "meld.providerPayoutAddress",
    orderRef: "meld.orderRef",
    meldFundingRequestId: "meld.meldFundingRequestId",
    quotedFiatAmount: "meld.quotedFiatAmount",
    quotedFiatCurrency: "meld.quotedFiatCurrency",
    cryptoCurrency: "meld.cryptoCurrency",
  };
  const out = { committedAmount };
  for (const [field, what] of Object.entries(strings)) {
    const value = String(meld[field] ?? "");
    if (!value) throw new Error(`startWithdraw: ${what} is required`);
    out[field] = value;
  }
  if (!isAssetHubAddress(out.providerPayoutAddress)) {
    throw new Error("startWithdraw: meld.providerPayoutAddress is not a valid Asset Hub account");
  }
  return out;
}

const freshRecordState = () => ({
  ...serialiseWithdrawTickState(freshWithdrawTickState()),
  workedMs: 0,
});

/** The surface's payment deadline, or null when it gave none. */
const paymentExpiryOf = (input) => {
  const at = Number(input.paymentExpiresAt);
  return Number.isFinite(at) && at > 0 ? at : null;
};

const mismatchReason = (derived, shown) =>
  `key mismatch: the worker derives ${derived} for this label, the surface shows ${shown}`;

/**
 * Registers a withdrawal handed over by the surface. Idempotent on sessionId. Returns the
 * record's public view; driving happens on wakes.
 */
export async function startWithdraw(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const existing = all[String(input.sessionId ?? "")];
  if (existing) {
    if (existing.v !== RECORD_V) {
      return { error: "invalid", reason: `session exists with record v${existing.v}` };
    }
    const shown = String(input.keyAddress ?? "");
    if (shown && shown !== existing.keyAddress) {
      return { error: "invalid", reason: mismatchReason(existing.keyAddress, shown) };
    }
    if (existing.phase === "failed") rearm(existing, Date.now());
    // A re-sent hand-off carries the surface's current payment window: a retried payment gets a
    // fresh one, and the job must not expire on the old clock while the surface waits on the new.
    existing.paymentExpiresAt = paymentExpiryOf(input) ?? existing.paymentExpiresAt;
    await saveJobs();
    return describeWithdraw(existing);
  }
  let record;
  try {
    record = newRecord(input, Date.now());
  } catch (error) {
    return { error: "invalid", reason: String(error?.message ?? error) };
  }
  const key = await keypairFor(record.label);
  if (key.address !== record.keyAddress) {
    return { error: "invalid", reason: mismatchReason(key.address, record.keyAddress) };
  }
  all[record.sessionId] = record;
  await saveJobs();
  return describeWithdraw(record);
}

/**
 * Re-arms a failed job on a re-sent hand-off. The run clock and the payment window restart. A
 * rejected job sizes and submits afresh; a job whose XCM landed keeps following its message.
 */
function rearm(record, nowMs) {
  const { failure } = record;
  // An unresolved payment is not a thing to try again: whether the provider holds the money is
  // unknown, and re-arming would drive straight back into the same refusal, or worse.
  if (failure === "unresolved") return;
  record.phase = "starting";
  delete record.failure;
  delete record.lastError;
  record.armedAt = nowMs;
  record.state.workedMs = 0;
  if (failure === "rejected" || failure === "timeout") {
    record.state.rejections = 0;
    record.state.payRejections = 0;
  }
  if (failure === "expired" || failure === "cancelled") record.state.fundsSeenAt = null;
}

function fail(record, failure, reason) {
  record.phase = "failed";
  record.failure = failure;
  record.lastError = reason;
}

/**
 * Marks a job still waiting for its payment as cancelled. The record is kept, and a re-sent
 * hand-off re-arms it. A job that has seen CASH is left running.
 */
export async function cancelWithdraw(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const record = all[String(input.sessionId ?? "")];
  if (!record) return { sessionId: String(input.sessionId ?? ""), known: false };
  const waitingForPayment = !record.done && record.state.fundsSeenAt === null;
  if (waitingForPayment && record.phase !== "failed") {
    fail(record, "cancelled", "cancelled by the surface");
    await saveJobs();
  }
  return describeWithdraw(record);
}

function describeWithdraw(record) {
  return {
    v: RECORD_V,
    sessionId: record.sessionId,
    phase: record.phase,
    done: record.done,
    amount: record.amount,
    createdAt: record.createdAt,
    lastTickAt: record.lastTickAt,
    lastError: record.lastError,
    failure: record.failure,
    submitting: record.submitting,
    txs: record.txs,
    fundsSeenAt: record.state?.fundsSeenAt ?? null,
  };
}

/** Reads one job by `sessionId`, or all jobs. */
export async function withdrawStatus(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const sessionId = String(input.sessionId ?? "");
  if (sessionId) {
    const record = all[sessionId];
    return record ? describeWithdraw(record) : { sessionId, known: false };
  }
  return { jobs: Object.values(all).map(describeWithdraw) };
}

/** True from the first tick that saw CASH until the XCM's message was processed. */
const onTheClock = (record) => !record.done && record.state.fundsSeenAt !== null;

/** Adds this tick's gap, capped at MAX_TICK_GAP_MS, to the job's worked time while on the clock. */
function accountWorkedTime(record, nowMs) {
  const previous = record.lastTickAt;
  record.lastTickAt = nowMs;
  if (previous === null || !onTheClock(record)) return;
  const gap = Math.min(Math.max(nowMs - previous, 0), MAX_TICK_GAP_MS);
  record.state.workedMs = (record.state.workedMs ?? 0) + gap;
}

/**
 * Fails a job over the run bound, or past the payment window when this tick read the chain and
 * no CASH has come. Called after the tick.
 */
function judgeBounds(record, nowMs, read) {
  if (record.phase === "failed") return;
  if (onTheClock(record) && (record.state.workedMs ?? 0) > RUN_TIMEOUT_MS) {
    fail(record, "timeout", `conversion exceeded ${RUN_TIMEOUT_MS}ms of worker time`);
    return;
  }
  const armedAt = record.armedAt ?? record.createdAt;
  const expiresAt = record.paymentExpiresAt ?? armedAt + PAYMENT_WINDOW_MS;
  const waitingForPayment = !record.done && record.state.fundsSeenAt === null;
  if (read && waitingForPayment && nowMs > expiresAt) {
    fail(record, "expired", "no payment arrived within the payment window");
  }
}

/** One tick for one record: connect, read the world, act at most once, persist, let go. */
async function tickRecord(record, nowMs) {
  accountWorkedTime(record, nowMs);
  const key = await keypairFor(record.label);
  const ahClient = await connectChain(record.assetHubGenesis, "asset hub");
  let peopleClient = null;
  try {
    peopleClient = await connectChain(record.peopleGenesis, "people");
    const assetHubApi = ahClient.getTypedApi(paseo_next_v2);
    const peopleApi = peopleClient.getTypedApi(paseo_people_next);

    // Restore the persisted state into the shape withdrawTickOnce mutates. The package owns
    // both halves of this round trip and copies EVERY field of the state generically: a
    // hand-written list here once dropped the evidence that keeps a provider from being paid
    // twice, because nothing makes a new field appear in a literal someone has to remember.
    const state = restoreWithdrawTickState(record.state);

    // Written before a submit and after every tick, thrown ones included; withdrawTickOnce
    // mutates the state as it works and a lost submit answer must keep its baseline. workedMs
    // is the engine's own bookkeeping and rides alongside, not part of the tick's state.
    const persistState = () => {
      record.state = {
        ...serialiseWithdrawTickState(state),
        workedMs: record.state.workedMs ?? 0,
      };
    };

    // An off-ramp's sale commits to an exact figure; the self-custody path carries no commitment
    // at all and is unaffected, exactly as it was before a rail could ever be "meld" here.
    const commitment = record.meld
      ? {
          planck: asBig(record.meld.committedAmount),
          payoutAddress: record.meld.providerPayoutAddress,
        }
      : undefined;
    // The funding engine's burner signs on Asset Hub with this same derived keypair (see
    // engine.js): one sr25519 signer serves every chain the key is asked to sign on, since papi
    // anchors the chain into the call it signs rather than the key. No second derivation here.
    const assetHubSigner = commitment ? key.signer : undefined;
    // Only fetched when a commitment needs it: the self-custody path pays no fee here and asks
    // for nothing on Asset Hub before the XCM itself lands.
    const assetHubSignOptions = commitment ? await signOptionsFor(ahClient) : undefined;

    let outcome;
    try {
      outcome = await withdrawTickOnce(
        {
          peopleApi,
          assetHubApi,
          key: {
            address: key.address,
            publicKeyHex: record.keyPublicKeyHex,
            signer: key.signer,
            ...(assetHubSigner ? { assetHubSigner } : {}),
          },
          destinationHex: record.landingHex,
          ...(commitment ? { commitment } : {}),
          assetHubParaId: record.assetHubParaId,
          peopleParaId: record.peopleParaId,
          poolAccount: record.poolAccount,
          slippagePct: record.slippagePct,
          tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
          submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
          // Every People submit shares this anchor; the Asset Hub payment gets its own below.
          signOptions: await signOptionsFor(peopleClient),
          ...(assetHubSignOptions ? { assetHubSignOptions } : {}),
          readKeyOnPeople: async (ss58) => {
            const [asset, native] = await Promise.all([
              peopleApi.query.Assets.Account.getValue(CASH_LOCATION, ss58),
              peopleApi.query.System.Account.getValue(ss58),
            ]);
            return { cash: asset?.balance ?? 0n, pas: native?.data?.free ?? 0n };
          },
          readDestinationOnAssetHub: (hex) => readDestinationPas(assetHubApi, hex),
          ...(commitment
            ? { readBurnerOnAssetHub: (hex) => readBurnerOnAssetHub(assetHubApi, hex) }
            : {}),
          now: Date.now,
          // Persisted before the broadcast leaves, and STRICTLY: a write that did not land
          // must stop the submit, or a pinned nonce can be lost out from under a transaction
          // already on its way and the next reload pays the provider a second time.
          onBeforeSubmit: async (call) => {
            persistState();
            record.submitting = { call, at: Date.now() };
            await saveJobsStrict();
          },
          // A change the end of the tick is too late to save: the pin moving on after an
          // answered failure. Losing it strands the run as unresolvable.
          onStateCheckpoint: async () => {
            persistState();
            await saveJobsStrict();
          },
          onTx: (info) => {
            delete record.submitting;
            record.txs.push(info);
          },
          onTransientError: (error) => {
            record.lastError = String(error?.message ?? error);
          },
        },
        state,
      );
    } finally {
      persistState();
    }
    // A cancel that landed during this tick stands.
    if (record.phase === "failed") return;
    record.phase = outcome.step;
    // A completed tick clears any stale submitting marker.
    delete record.submitting;
    if (outcome.step === "done") record.done = true;
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
 * Drives every live job one tick. Per-job errors are recorded on the job and contained. A job
 * ends only through `fail` or its message's processing; a re-sent hand-off re-arms a failed one.
 */
export async function tickAllWithdraw() {
  if (ticking) return { ticked: 0, busy: true };
  ticking = true;
  try {
    const all = await loadJobs();
    const live = Object.values(all).filter(
      (record) => record?.v === RECORD_V && !record.done && record.phase !== "failed",
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
        if (error instanceof WithdrawRejectedError) {
          fail(record, "rejected", error.message);
        } else if (error instanceof PaymentUnresolvedError) {
          // Whether the provider was paid cannot be settled from the chain's head. Retrying
          // cannot learn more and the pinned nonce makes a retry a no-op anyway, so the job
          // stops here for a human rather than looping on an unanswerable question.
          fail(record, "unresolved", error.message);
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
