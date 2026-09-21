import { CASH_LOCATION } from "@getsome/people";
import {
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  freshRailLegState,
  freshSweepState,
  freshWithdrawTickState,
  RailFailedError,
  railTickOnce,
  readDestinationPas,
  withdrawTickOnce,
  WithdrawRejectedError,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { readParams } from "./params.js";
import { payRail, railFor } from "./providers.js";
import {
  asBig,
  bounded,
  connectChain,
  createJobStore,
  keypairFor,
  signOptionsFor,
} from "./shared.js";

// The withdrawal engine: the only driver of withdrawTickOnce and railTickOnce, one tick per live
// job per pass. The message leg moves the CASH to Asset Hub as PAS; for a destination beyond
// Asset Hub the rail leg then hands the PAS to a provider and follows its word.
//
// Once this engine holds a job it is the only writer for it. The surface only reads records back.
// Each dispatch runs at most one tick per live job, persists what it learned, and exits. Records
// carry the entropy label, never a secret; the key is re-derived on every wake. The engine never
// starts a payment: it watches the key the purse pays and moves what lands there.

/** Bump when the record shape changes; readers skip versions they don't know. */
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

/**
 * One withdrawal job's record, as persisted between wakes.
 *
 * {
 *   v: 1, sessionId, label,                  // label: the entropy label the surface used
 *   keyAddress, keyPublicKeyHex,             // the key the surface showed and the purse pays
 *   amount, destination, landingHex, rail,   // what the surface asked for; kept for its records
 *   channel?,                                // the provider's channel the page opened
 *   assetHubGenesis, peopleGenesis, peopleParaId, assetHubParaId, poolAccount, slippagePct,
 *   paymentExpiresAt: number|null,
 *   phase: "starting" | WithdrawStep | RailStep | "failed",
 *   failure?: "rejected" | "timeout" | "expired" | "cancelled" | "no-rail" | "rail-failed",
 *   landed,                                  // the message leg is done: PAS on Asset Hub
 *   done, createdAt, armedAt, lastTickAt, lastError?,
 *   state: { attempts, rejections, submitted, destinationPasBefore, expectedLanding,
 *            fundsSeenAt, workedMs },       // the two balances as decimal strings or null
 *   leg: { handoff, paid, sweep, reading },  // the rail leg, for a provider rail
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
  if (!RAILS.includes(input.rail)) {
    throw new Error(`startWithdraw: rail must be one of ${RAILS.join(", ")}`);
  }
  if (input.rail !== "direct" && !isChannel(input.channel)) {
    throw new Error("startWithdraw: a provider rail needs the channel the page opened");
  }
  if (!assetHubGenesis || !peopleGenesis) {
    throw new Error("startWithdraw: both chain genesis hashes are required");
  }
  if (!Number.isInteger(peopleParaId) || !Number.isInteger(assetHubParaId)) {
    throw new Error("startWithdraw: peopleParaId and assetHubParaId must be integers");
  }
  if (!poolAccount) throw new Error("startWithdraw: the pool account is required");
  if (!(slippagePct > 0)) throw new Error("startWithdraw: slippagePct must be positive");
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
    // Kept as handed over, so a surface that lost its record can rebuild the hand-off whole.
    ...(isChannel(input.channel) ? { channel: channelOf(input.channel) } : {}),
    phase: "starting",
    landed: false,
    done: false,
    createdAt: nowMs,
    armedAt: nowMs,
    lastTickAt: null,
    state: freshRecordState(),
    leg: legFor(input, nowMs),
    txs: [],
  };
}

/** The rails a hand-off may name; `direct` ends with the message, the rest add the rail leg. */
const RAILS = ["direct", "chainflip", "meld"];

/** A channel as the page hands it over: the provider's id and the Asset Hub account to pay. */
const isChannel = (channel) =>
  typeof channel === "object" &&
  channel !== null &&
  typeof channel.id === "string" &&
  channel.id !== "" &&
  typeof channel.address === "string" &&
  channel.address !== "";

/** The channel's fields as the surface sent them, numbers and strings only. */
function channelOf(channel) {
  const openedAt = Number(channel.openedAt);
  const expiresAt = Number(channel.expiresAt);
  return {
    id: channel.id,
    address: channel.address,
    openedAt: Number.isFinite(openedAt) && openedAt > 0 ? openedAt : 0,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
    expectedEgress: String(channel.expectedEgress ?? "0"),
  };
}

/** A fresh rail leg, seeded with the hand-off's channel when it carries one. */
function legFor(input, nowMs) {
  const leg = freshRailLegState();
  if (isChannel(input.channel)) {
    const { id, address, openedAt } = channelOf(input.channel);
    leg.handoff = { id, address, openedAt: openedAt || nowMs };
  }
  return leg;
}

const freshRecordState = () => ({ ...freshWithdrawTickState(), workedMs: 0 });

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
    // A fresh channel, after a swap that refunded, starts the rail leg over: unpaid, unread.
    if (isChannel(input.channel) && input.channel.id !== existing.leg?.handoff?.id) {
      existing.channel = channelOf(input.channel);
      existing.leg = legFor(input, Date.now());
    }
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
 * rejected job sizes and submits afresh; a job whose XCM landed keeps following its message; a
 * job whose provider failed starts the rail leg over with the fresh channel the hand-off brings.
 */
function rearm(record, nowMs) {
  const { failure } = record;
  record.phase = "starting";
  delete record.failure;
  delete record.lastError;
  record.armedAt = nowMs;
  record.state.workedMs = 0;
  if (failure === "rejected" || failure === "timeout") {
    record.state.rejections = 0;
    if (record.leg?.sweep) record.leg.sweep.rejections = 0;
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
    // Records from before the rail leg carry no `landed`; for them the message was the whole job.
    landed: record.landed ?? record.done,
    done: record.done,
    ...(record.leg?.reading == null ? {} : { rail: record.leg.reading }),
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

/**
 * Dev builds only: takes the provider's word as delivered for a job on the rail leg, so the walk
 * can be finished where the provider cannot be reached. On a test network the channel is real
 * but the swap never runs, since the provider watches another chain.
 */
export async function skipWithdrawRail(params) {
  const input = readParams(params);
  const all = await loadJobs();
  const sessionId = String(input.sessionId ?? "");
  const record = all[sessionId];
  if (!record) return { sessionId, known: false };
  if (!record.landed || record.done || record.rail === "direct" || record.phase === "failed") {
    return { error: "invalid", reason: "the job is not on the rail leg" };
  }
  record.leg = { ...(record.leg ?? freshRailLegState()), reading: { status: "complete" } };
  record.phase = "done";
  record.done = true;
  await saveJobs();
  return describeWithdraw(record);
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

/** True from the first tick that saw CASH until the job's own work is over: the message
 *  processed for a direct rail, the provider paid for the rest. What the provider then takes is
 *  its time, not this worker's. */
const onTheClock = (record) =>
  !record.done && record.state.fundsSeenAt !== null && !(record.landed && record.leg?.paid);

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

/**
 * One tick on the rail leg: the provider's channel opened, then paid, then read. The worker
 * persists the channel before paying it, so a payment whose answer is lost is never made twice.
 * The provider's verdict ends the leg: delivered completes the job, a failure fails it with the
 * reading kept for the surface to read.
 */
async function tickRailLeg(record) {
  const rail = railFor(record.rail, record);
  if (rail === null) {
    fail(record, "no-rail", `no ${record.rail} provider in this build`);
    return;
  }
  const state = {
    handoff: record.leg?.handoff ?? null,
    paid: record.leg?.paid === true,
    sweep: record.leg?.sweep ?? freshSweepState(),
    reading: record.leg?.reading ?? null,
  };
  const persistLeg = () => {
    record.leg = {
      handoff: state.handoff,
      paid: state.paid,
      sweep: state.sweep,
      reading: state.reading,
    };
  };
  const persistAndSave = async () => {
    persistLeg();
    await saveJobs();
  };
  let outcome;
  try {
    outcome = await railTickOnce(
      {
        rail,
        pay: (handoff, sweep) =>
          payRail(record, handoff, sweep, {
            onBeforeSubmit: persistAndSave,
            onTx: (info) => record.txs.push(info),
          }),
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        // The payment reads the key and then submits, each on its own bound; this outer bound
        // must outlast both, or it fires while the transfer is still in flight.
        payTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS + DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
        now: Date.now,
        onBeforePay: persistAndSave,
      },
      state,
    );
  } catch (error) {
    persistLeg();
    if (error instanceof RailFailedError) {
      fail(record, "rail-failed", error.message);
      return;
    }
    throw error;
  }
  persistLeg();
  // A cancel that landed during this tick stands.
  if (record.phase === "failed") return;
  record.phase = outcome.step;
  if (outcome.step === "done") record.done = true;
}

/** One tick for one record: connect, read the world, act at most once, persist, let go. The
 *  message leg until the PAS is on Asset Hub, the rail leg after that for a provider rail. */
async function tickRecord(record, nowMs) {
  accountWorkedTime(record, nowMs);
  if (record.landed && record.rail !== "direct") {
    await tickRailLeg(record);
    return;
  }
  const key = await keypairFor(record.label);
  const ahClient = await connectChain(record.assetHubGenesis, "asset hub");
  let peopleClient = null;
  try {
    peopleClient = await connectChain(record.peopleGenesis, "people");
    const assetHubApi = ahClient.getTypedApi(paseo_next_v2);
    const peopleApi = peopleClient.getTypedApi(paseo_people_next);

    // Restore the persisted state into the shape withdrawTickOnce mutates.
    const state = freshWithdrawTickState();
    state.attempts = record.state.attempts ?? 0;
    state.rejections = record.state.rejections ?? 0;
    state.submitted = !!record.state.submitted;
    state.destinationPasBefore = asBig(record.state.destinationPasBefore, null);
    state.expectedLanding = asBig(record.state.expectedLanding, null);
    state.fundsSeenAt = record.state.fundsSeenAt ?? null;

    // Written before a submit and after every tick, thrown ones included; withdrawTickOnce
    // mutates the state as it works and a lost submit answer must keep its baseline.
    const persistState = () => {
      record.state = {
        attempts: state.attempts,
        rejections: state.rejections,
        submitted: state.submitted,
        destinationPasBefore:
          state.destinationPasBefore === null ? null : String(state.destinationPasBefore),
        expectedLanding: state.expectedLanding === null ? null : String(state.expectedLanding),
        fundsSeenAt: state.fundsSeenAt,
        workedMs: record.state.workedMs ?? 0,
      };
    };

    let outcome;
    try {
      outcome = await withdrawTickOnce(
        {
          peopleApi,
          assetHubApi,
          key: { address: key.address, publicKeyHex: record.keyPublicKeyHex, signer: key.signer },
          destinationHex: record.landingHex,
          assetHubParaId: record.assetHubParaId,
          peopleParaId: record.peopleParaId,
          poolAccount: record.poolAccount,
          slippagePct: record.slippagePct,
          tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
          submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
          // Every submit is on People; one anchor per tick serves them all.
          signOptions: await signOptionsFor(peopleClient),
          readKeyOnPeople: async (ss58) => {
            const [asset, native] = await Promise.all([
              peopleApi.query.Assets.Account.getValue(CASH_LOCATION, ss58),
              peopleApi.query.System.Account.getValue(ss58),
            ]);
            return { cash: asset?.balance ?? 0n, pas: native?.data?.free ?? 0n };
          },
          readDestinationOnAssetHub: (hex) => readDestinationPas(assetHubApi, hex),
          now: Date.now,
          // Persisted before the broadcast leaves.
          onBeforeSubmit: async (call) => {
            persistState();
            record.submitting = { call, at: Date.now() };
            await saveJobs();
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
    if (outcome.step === "done") {
      // The PAS is on Asset Hub. That is the whole job for a direct rail; a provider rail
      // carries on from the key on the next tick.
      record.landed = true;
      if (record.rail === "direct") record.done = true;
      else record.phase = "handoff";
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
