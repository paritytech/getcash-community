import { NETWORK } from "@getsome/core";
import { chooseCashTransfer, PASEO_UNDERLYING_ASSET_ID } from "@getsome/funding";
import { MELD_SELL_ENABLED } from "@getsome/meld";
import { CASH_LOCATION } from "@getsome/people";
import {
  CHANNEL_EXPIRY_MARGIN_MS,
  ChannelExpiredError,
  ChannelMismatchError,
  CommitmentUnfundableError,
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  exactPaymentFloor,
  freshExactPayState,
  freshRailLegState,
  freshSweepState,
  freshWithdrawTickState,
  PaymentUnresolvedError,
  RailFailedError,
  railTickOnce,
  readAssetHubAccount,
  readDestinationPas,
  SALE_RESIDUE_RETURN_FLOOR,
  withdrawTickOnce,
  WithdrawRejectedError,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { CLAIM_UNIT, fundingStatus, startFunding } from "./engine.js";
import { readParams } from "./params.js";
import { exactPaymentOut, PAY_TIMEOUT_MS, payRail, payRailExact, railFor } from "./providers.js";
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
/** The funding job's target for a key sent home: one claim unit of CASH. The pipeline converts
 *  everything the key holds whatever the target, so the target only has to be reachable; the
 *  price is held by `quoteFloorPct` instead, and CASH already on People is claimed as it is. */
const RESIDUE_SETTLE_AMOUNT = CLAIM_UNIT.toString();
/** Where the claims of a key sent home start counting their ids. The purse's payments to the key
 *  are registered under ids derived from its public key and the attempt, as the claims are, so the
 *  claims start far past any attempt a withdrawal makes. */
const RESIDUE_CLAIM_ID_OFFSET = 1_000_000;
/** The failures before the provider is paid that do not send a sale's key home: a job whose
 *  payment never came and one the page cancelled hold nothing, and a re-sent hand-off may still
 *  revive them; a payment that cannot be confirmed waits for a person. Any other failure ends the
 *  sale, and the key goes home whole. */
const KEPT_ON_FAILURE = new Set(["expired", "cancelled", "unresolved"]);
/** How long a submit whose answer was lost may still land: past its mortality, with room. Until
 *  then a sale is not called unfundable, since the CASH it would send home may be on its way. */
const SUBMIT_SETTLE_MS = 600_000;
/** How many times the worker starts a key's way home again after the funding job carrying it
 *  failed, before leaving it for a person. */
const RETURN_REARMS = 3;

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
 *   channel?,                                // the provider's channel the page opened; for Meld
 *                                            // its `amount` is the exact planck the key pays
 *   meld?: { baseUrl?, productId?, offline? }, // Meld only: the adapter the sale is read from
 *   assetHubGenesis, peopleGenesis, peopleParaId, assetHubParaId, poolAccount, slippagePct,
 *   paymentExpiresAt: number|null,
 *   phase: "starting" | WithdrawStep | RailStep | "failed",
 *   failure?: "rejected" | "timeout" | "expired" | "cancelled" | "no-rail" | "rail-failed"
 *            | "channel-expired" | "channel-mismatch" | "unfundable" | "unresolved",
 *   landed,                                  // the message leg is done: PAS on Asset Hub
 *   done, createdAt, armedAt, lastTickAt, lastError?,
 *   state: { attempts, rejections, submitted, destinationPasBefore, expectedLanding,
 *            fundsSeenAt, workedMs },       // the two balances as decimal strings or null
 *   leg: { handoff, paid, sweep, exact?, reading },  // the rail leg, for a provider rail;
 *                                            // exact: the Meld payment's nonce, in flight or
 *                                            // not, and the block its attempt is anchored at
 *   saleNotFound?, saleNotFoundSince?,       // Meld only: the adapter's 404s in a row, and since
 *   residue?: { amount?, returning, whole?, sessionId?, rearms?, stuck? },
 *                                            // Meld only: what the sale left on the key once
 *                                            // the provider was paid, and its way home; whole:
 *                                            // the sale ended unpaid and all of it goes home;
 *                                            // stuck: its funding job failed past RETURN_REARMS
 *   residueError?,                           // why the way home's last step failed; the
 *                                            // next pass tries it again
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
  if (input.rail === "meld" && channelOf(input.channel).amount === undefined) {
    throw new Error("startWithdraw: a Meld sale needs the exact amount its provider expects");
  }
  if (input.rail === "meld" && meldOf(input.meld) === null) {
    throw new Error("startWithdraw: a Meld sale needs the adapter it is read from");
  }
  if (input.rail === "meld" && meldOf(input.meld)?.offline === true && !NETWORK.testnet) {
    throw new Error("startWithdraw: the stand-in sale runs only on a test network");
  }
  // The page offers card and bank only where the build sells for fiat; the worker holds the same
  // line rather than trusting the page not to ask.
  if (input.rail === "meld" && !MELD_SELL_ENABLED) {
    throw new Error("startWithdraw: card and bank withdrawals are not open on this network");
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
    ...(input.rail === "meld" ? { meld: meldOf(input.meld) } : {}),
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

/** The channel's fields as the surface sent them, numbers and strings only. `amount` is kept only
 *  as a positive whole number of planck. */
function channelOf(channel) {
  const openedAt = Number(channel.openedAt);
  const expiresAt = Number(channel.expiresAt);
  const amount = /^\d+$/.test(String(channel.amount ?? "")) ? String(channel.amount) : undefined;
  return {
    id: channel.id,
    address: channel.address,
    openedAt: Number.isFinite(openedAt) && openedAt > 0 ? openedAt : 0,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
    expectedEgress: String(channel.expectedEgress ?? "0"),
    ...(amount !== undefined && asBig(amount) > 0n ? { amount } : {}),
  };
}

/** The adapter a Meld sale is read from, or the page's word that it ran the offline sale. Null
 *  when the hand-off says neither. */
function meldOf(meld) {
  if (typeof meld !== "object" || meld === null) return null;
  if (meld.offline === true) return { offline: true };
  if (typeof meld.baseUrl !== "string" || meld.baseUrl === "") return null;
  return {
    baseUrl: meld.baseUrl,
    ...(typeof meld.productId === "string" && meld.productId ? { productId: meld.productId } : {}),
  };
}

/** A fresh rail leg, seeded with the hand-off's channel when it carries one. The expiry rides
 *  along: the leg refuses to pay a channel the provider has closed. An exact payment starts at the
 *  key's first nonce on Asset Hub. */
function legFor(input, nowMs) {
  const leg = freshRailLegState();
  if (isChannel(input.channel)) {
    const { id, address, openedAt, expiresAt } = channelOf(input.channel);
    leg.handoff = { id, address, openedAt: openedAt || nowMs, expiresAt };
  }
  if (input.rail === "meld") leg.exact = freshExactPayState();
  return leg;
}

/** Moves the deadline of a sale's unpaid channel out to the one `channel` carries for the same id,
 *  when that is later. A Chainflip channel's expiry is the provider's, and never moves. */
function extendDeadline(record, channel) {
  const handoff = record.leg?.handoff;
  if (record.rail !== "meld" || !isChannel(channel) || handoff == null) return;
  if (record.leg.paid === true) return;
  if (channel.id !== handoff.id) return;
  const { expiresAt } = channelOf(channel);
  if (expiresAt <= (handoff.expiresAt ?? 0)) return;
  record.channel = { ...record.channel, expiresAt };
  record.leg.handoff = { ...handoff, expiresAt };
}

/** The channel this job's rail leg pays. The expiry is taken from the record's own channel when
 *  the leg does not carry one, so a job stored before the leg kept it is still held to it. */
function handoffOf(record) {
  const handoff = record.leg?.handoff ?? null;
  if (handoff === null) return null;
  if (typeof handoff.expiresAt === "number") return handoff;
  const expiresAt = Number(record.channel?.expiresAt);
  return { ...handoff, expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0 };
}

/** `current`, with the deadline `latest` carries for the same channel when that one is later. */
function laterDeadline(current, latest) {
  if (current == null || latest == null || latest.id !== current.id) return current;
  return (latest.expiresAt ?? 0) > (current.expiresAt ?? 0)
    ? { ...current, expiresAt: latest.expiresAt }
    : current;
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
    // A sale whose key goes home whole never pays its provider again, whatever is re-sent, and
    // one whose payment could not be confirmed waits for a person, not for a re-sent hand-off.
    const held = goesHomeWhole(existing) || existing.failure === "unresolved";
    if (existing.phase === "failed" && !held) rearm(existing, Date.now());
    // A re-sent hand-off carries the surface's current payment window: a retried payment gets a
    // fresh one, and the job must not expire on the old clock while the surface waits on the new.
    existing.paymentExpiresAt = paymentExpiryOf(input) ?? existing.paymentExpiresAt;
    // A fresh channel, after a swap that refunded, starts the rail leg over: unpaid, unread. Not
    // for a sale, which has one order and whose leg holds the payment's nonce.
    if (
      existing.rail !== "meld" &&
      isChannel(input.channel) &&
      input.channel.id !== existing.leg?.handoff?.id
    ) {
      existing.channel = channelOf(input.channel);
      existing.leg = legFor(input, Date.now());
    }
    // The same channel with a later deadline: a sale's purse asked again gives the key its time to
    // pay the provider again. Only while the provider is unpaid, and never shortened.
    extendDeadline(existing, input.channel);
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
 * Chainflip job whose provider failed starts the rail leg over with the fresh channel the hand-off
 * brings. Not a sale whose key goes home whole, nor one whose payment could not be confirmed.
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
    // The nonce stays where the refusals left it: nothing went out at the ones they spent.
    if (record.leg?.exact) record.leg.exact.rejections = 0;
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
    residue: record.residue ?? null,
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
  !record.done &&
  record.state.fundsSeenAt !== null &&
  // A sale stops the clock once its PAS has landed: paying its provider is held to the sale's own
  // deadline and to the payment's mortality, not to worker time.
  !(record.rail === "meld" ? record.landed : record.landed && record.leg?.paid);

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
  // A Meld sale pays the exact figure its provider quoted, never everything the key holds.
  const exactAmount = record.rail === "meld" ? asBig(record.channel?.amount, 0n) : null;
  if (exactAmount !== null && exactAmount <= 0n) {
    fail(record, "channel-mismatch", "the sale carries no amount to pay its provider");
    return;
  }
  const state = {
    handoff: handoffOf(record),
    paid: record.leg?.paid === true,
    sweep: record.leg?.sweep ?? freshSweepState(),
    reading: record.leg?.reading ?? null,
  };
  const exact = record.leg?.exact ?? freshExactPayState();
  const persistLeg = () => {
    record.leg = {
      // A deadline a re-sent hand-off moved out while this tick ran is kept.
      handoff: laterDeadline(state.handoff, record.leg?.handoff),
      paid: state.paid,
      sweep: state.sweep,
      ...(exactAmount === null ? {} : { exact }),
      reading: state.reading,
    };
  };
  const persistAndSave = async () => {
    persistLeg();
    await saveJobs();
  };
  const hooks = { onBeforeSubmit: persistAndSave, onTx: (info) => record.txs.push(info) };
  let outcome;
  try {
    outcome = await railTickOnce(
      {
        rail,
        pay: (handoff, sweep) =>
          exactAmount === null
            ? payRail(record, handoff, sweep, hooks)
            : payRailExact(record, handoff, exactAmount, exact, hooks),
        tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
        destinationAddress: record.destination?.address,
        ...(exactAmount === null
          ? {}
          : {
              payout: "off-chain",
              amount: exactAmount,
              // A payment whose answer was lost is read off the chain before the adapter, whose
              // record of an order that got its funds may already read as closed.
              landed: () => exactPaymentOut(record, exactAmount, exact),
            }),
        // Outlasts every bound inside the hand that pays, so it never fires mid transfer.
        payTimeoutMs: PAY_TIMEOUT_MS,
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
    const refused = error instanceof ChannelExpiredError || error instanceof ChannelMismatchError;
    // A sale's earlier attempt may still land even though the chain does not show it yet, so the
    // provider's refusal does not say nothing was sent. The job holds until the chain settles it:
    // the attempt lands and the sale is paid, or it outlives its mortality unlanded and the
    // refusal stands (see `exactPaymentLanded`).
    if (refused && exactAmount !== null && exact.inFlight) {
      record.lastError = `the provider refused the sale while a payment to it may still land: ${error.message}`;
      return;
    }
    // Nothing moved: the native is still on the key. A fresh Chainflip channel can carry it; a
    // sale's key goes home whole (see `returnDue`).
    if (error instanceof ChannelExpiredError) {
      fail(record, "channel-expired", error.message);
      return;
    }
    if (error instanceof ChannelMismatchError) {
      fail(record, "channel-mismatch", error.message);
      return;
    }
    // Whether the provider was paid cannot be told: nothing more leaves the key until a human
    // has looked.
    if (error instanceof PaymentUnresolvedError) {
      fail(record, "unresolved", error.message);
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

/** The funding job that brings what a sale left on its key home. Not a `<source>:<n>` id, so the
 *  surface never mistakes it for a top-up of its own. */
const residueSessionId = (record) => `${record.sessionId}/residue`;

/**
 * What a Meld sale still owes the purse: `residue`, what the key holds once the provider is paid,
 * or `whole`, everything it holds when the sale failed before the provider could be paid. Null
 * when nothing is owed, once the way home is on the job, and while a payment or a message may
 * still land: a key that may have paid moves nothing more until the chain has settled it
 * (`settleInFlight`).
 */
function returnDue(record, nowMs = Date.now()) {
  if (record.rail !== "meld" || record.residue !== undefined) return null;
  if (record.leg?.paid === true) return "residue";
  if (record.phase !== "failed" || KEPT_ON_FAILURE.has(record.failure)) return null;
  if (record.leg?.exact?.inFlight === true || submitMayLand(record, nowMs)) return null;
  return "whole";
}

/** A failed sale whose payment to its provider may still land: the chain settles it before
 *  anything goes home. */
const inFlightAfterFailure = (record) =>
  record.rail === "meld" &&
  record.phase === "failed" &&
  record.failure !== "unresolved" &&
  record.residue === undefined &&
  record.leg?.paid !== true &&
  record.leg?.exact?.inFlight === true;

/**
 * Asks the chain whether a failed sale's in-flight payment landed. Landed, the provider was paid
 * and only what is left goes home; past its mortality unlanded, the key goes home whole; otherwise
 * the next pass asks again. A chain that contradicts the payment stops the job for a person.
 */
async function settleInFlight(record) {
  try {
    const landed = await exactPaymentOut(
      record,
      asBig(record.channel?.amount, 0n),
      record.leg.exact,
    );
    if (landed) record.leg = { ...record.leg, paid: true };
  } catch (error) {
    if (!(error instanceof PaymentUnresolvedError)) throw error;
    fail(record, "unresolved", error.message);
  }
}

/** Whether a sale's key holds anything worth the way home: CASH on People, or PAS on Asset Hub at
 *  or above the floor a residue is sent home at. */
async function keyHoldsAnything(record) {
  const assetHub = await connectChain(record.assetHubGenesis, "asset hub");
  try {
    const account = await bounded(
      readAssetHubAccount(assetHub.getTypedApi(paseo_next_v2), record.keyPublicKeyHex),
      DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
      "key read on asset hub",
    );
    if (account.free >= SALE_RESIDUE_RETURN_FLOOR) return true;
  } finally {
    assetHub.destroy();
  }
  const people = await connectChain(record.peopleGenesis, "people");
  try {
    const cash = await bounded(
      people
        .getTypedApi(paseo_people_next)
        .query.Assets.Account.getValue(CASH_LOCATION, record.keyAddress),
      DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
      "key read on people",
    );
    return (cash?.balance ?? 0n) > 0n;
  } finally {
    people.destroy();
  }
}

/** A submit whose answer was lost may still land until SUBMIT_SETTLE_MS after it left. */
const submitMayLand = (record, nowMs) =>
  record.submitting != null && nowMs - (record.submitting.at ?? 0) < SUBMIT_SETTLE_MS;

/** Nothing has been submitted for the sale, nor may be on its way. */
const unsubmitted = (record, nowMs) =>
  record.state?.submitted !== true && !submitMayLand(record, nowMs);

/** The sale's time to pay its provider is up, by the same margin the rail leg holds it to. */
function saleOverdue(record, nowMs) {
  const expiresAt = Number(record.leg?.handoff?.expiresAt ?? record.channel?.expiresAt ?? 0);
  return (
    Number.isFinite(expiresAt) && expiresAt > 0 && nowMs >= expiresAt - CHANNEL_EXPIRY_MARGIN_MS
  );
}

/** The way home of a sale's key is started and not yet known to be over. */
const wayHomeOpen = (record) =>
  record.rail === "meld" &&
  record.residue?.returning === true &&
  typeof record.residue.sessionId === "string" &&
  record.residue.returned !== true &&
  record.residue.stuck !== true;

/** The sale's key goes home whole, or already is on its way. */
const goesHomeWhole = (record) => record.residue?.whole === true || returnDue(record) === "whole";

/**
 * Sends what a Meld sale left on its key home as CASH, through the funding engine, as it does an
 * on-ramp: everything the key holds on Asset Hub is converted, teleported to the key on People
 * and claimed into the purse, and CASH already on People is claimed as it is. So a residue starts
 * strictly after the payment is on chain, or that conversion would take the provider's figure too,
 * and one below SALE_RESIDUE_RETURN_FLOOR stays on the key. A sale that ended unpaid sends everything,
 * wherever it is: the CASH still on People when the price moved, the PAS on Asset Hub when the
 * provider closed the order. The exchange is held to the bound the sale itself went out under.
 */
async function sendHome(record, kind) {
  let amount = null;
  if (kind === "residue") {
    const client = await connectChain(record.assetHubGenesis, "asset hub");
    try {
      const assetHubApi = client.getTypedApi(paseo_next_v2);
      amount = (
        await bounded(
          readAssetHubAccount(assetHubApi, record.keyPublicKeyHex),
          DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
          "residue read",
        )
      ).free;
    } finally {
      client.destroy();
    }
    if (amount < SALE_RESIDUE_RETURN_FLOOR) {
      record.residue = { amount: amount.toString(), returning: false };
      return;
    }
  } else if (!(await keyHoldsAnything(record))) {
    // A sale that failed before anything reached its key: no way home to start.
    record.residue = { whole: true, returning: false };
    return;
  }
  // The way home is on the job, and stored, before its funding job exists: a worker stopped in
  // between finds the sale over and its way home open, and follows it (`keepWayHome`), rather than
  // driving the sale on or reading a key the funding job is already emptying.
  record.residue = {
    ...(amount === null ? { whole: true } : { amount: amount.toString() }),
    returning: true,
    sessionId: residueSessionId(record),
  };
  await saveJobs();
  await startWayHome(record);
}

/** Starts, or re-arms, the funding job that carries a sale's key home. Throws when it is refused,
 *  and the next pass tries again. */
async function startWayHome(record) {
  const started = await startFunding(wayHomeParams(record));
  if (started?.error) throw new Error(started.reason ?? started.error);
}

/** The funding job that carries a sale's key home: a pool job on the key, held to the bound the
 *  sale itself went out under, claimed under ids far past the purse's payments to the key. */
const wayHomeParams = (record) => ({
  sessionId: residueSessionId(record),
  label: record.label,
  burnerAddress: record.keyAddress,
  settleAmount: RESIDUE_SETTLE_AMOUNT,
  underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
  peopleParaId: record.peopleParaId,
  assetHubGenesis: record.assetHubGenesis,
  peopleGenesis: record.peopleGenesis,
  tier: "pool",
  quoteFloorPct: record.slippagePct,
  claimIdOffset: RESIDUE_CLAIM_ID_OFFSET,
});

/**
 * Follows a key's way home once it is on the job: notes when its funding job has claimed the
 * funds, starts that job when it never started (the start was refused, or the worker stopped
 * first), and starts it again when it failed, up to RETURN_REARMS times. Past that the residue is
 * marked stuck, for a person.
 */
async function keepWayHome(record) {
  const residue = record.residue;
  const job = await fundingStatus({ sessionId: residue.sessionId });
  if (job?.claim?.phase === "claimed") {
    record.residue = { ...residue, returned: true };
    return;
  }
  if (job?.known === false) {
    await startWayHome(record);
    return;
  }
  if (job?.phase !== "failed") return;
  const rearms = residue.rearms ?? 0;
  if (rearms >= RETURN_REARMS) {
    record.residue = { ...residue, stuck: true };
    return;
  }
  await startWayHome(record);
  record.residue = { ...residue, rearms: rearms + 1 };
}

/** One tick for one record: connect, read the world, act at most once, persist, let go. The
 *  message leg until the PAS is on Asset Hub, the rail leg after that for a provider rail. */
async function tickRecord(record, nowMs) {
  accountWorkedTime(record, nowMs);
  if (record.landed && record.rail !== "direct") {
    await tickRailLeg(record);
    return;
  }
  // A sale past its time to pay the provider is not sold at all: its key goes home as the CASH it
  // holds, rather than as PAS bought for a payment that will not be made. Only while nothing has
  // been submitted for it, so no message is on its way.
  if (record.rail === "meld" && saleOverdue(record, nowMs) && unsubmitted(record, nowMs)) {
    fail(
      record,
      "channel-expired",
      "the sale's time to pay its provider ran out before it was sold",
    );
    return;
  }
  const key = await keypairFor(record.label);
  const ahClient = await connectChain(record.assetHubGenesis, "asset hub");
  let peopleClient = null;
  try {
    peopleClient = await connectChain(record.peopleGenesis, "people");
    const assetHubApi = ahClient.getTypedApi(paseo_next_v2);
    const peopleApi = peopleClient.getTypedApi(paseo_people_next);
    // Asked on every dispatch, so a runtime upgrade between ticks is picked up before the next
    // submit; a network with no transfer fails the tick like any other read.
    const transfer = await bounded(
      chooseCashTransfer({
        assetHub: ahClient,
        people: peopleClient,
        assetHubParaId: record.assetHubParaId,
        peopleParaId: record.peopleParaId,
      }),
      DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
      "cash transfer choice",
    );

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
          transfer,
          // A Meld sale promised its provider an exact figure out of what lands: the sale must
          // cover it, its fee and the key's existential deposit, or nothing leaves People.
          ...(record.rail === "meld"
            ? {
                minLanding: () =>
                  exactPaymentFloor(
                    assetHubApi,
                    key.address,
                    record.channel.address,
                    asBig(record.channel.amount, 0n),
                  ),
              }
            : {}),
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

const isLive = (record) => !record.done && record.phase !== "failed";

/**
 * Drives every live job one tick, and sends home what a sale's key still owes the purse, done or
 * failed, following that way home until it is over. Per-job errors are recorded on the job and
 * contained. A job ends only through `fail` or its message's processing; a re-sent hand-off
 * re-arms a failed one, except as `rearm` says.
 */
export async function tickAllWithdraw() {
  if (ticking) return { ticked: 0, busy: true };
  ticking = true;
  try {
    const all = await loadJobs();
    const due = Object.values(all).filter(
      (record) =>
        record?.v === RECORD_V &&
        (isLive(record) ||
          returnDue(record) !== null ||
          wayHomeOpen(record) ||
          inFlightAfterFailure(record)),
    );
    let ticked = 0;
    for (const record of due) {
      // Cancelled since this pass began, with nothing owed.
      if (
        !isLive(record) &&
        returnDue(record) === null &&
        !wayHomeOpen(record) &&
        !inFlightAfterFailure(record)
      ) {
        continue;
      }
      if (isLive(record)) {
        const nowMs = Date.now();
        let read = false;
        try {
          await tickRecord(record, nowMs);
          read = true;
        } catch (error) {
          if (error instanceof WithdrawRejectedError) {
            fail(record, "rejected", error.message);
          } else if (error instanceof CommitmentUnfundableError && !submitMayLand(record, nowMs)) {
            // The price moved past what the sale promised its provider before anything left
            // People. The CASH goes home (see `returnDue`). Not while an earlier submit may still
            // land, which would move that CASH on.
            fail(record, "unfundable", error.message);
          } else {
            // Other errors are transient; the next wake retries.
            record.lastError = String(error?.message ?? error);
          }
        }
        judgeBounds(record, nowMs, read);
      }
      // Off the payment's path, and tried again on every pass until it is over, whatever became of
      // the job meanwhile: a sale done or failed is not ticked again, but its key still goes home.
      // A failed sale's payment that may still land is settled by the chain first.
      if (inFlightAfterFailure(record)) {
        try {
          await settleInFlight(record);
          delete record.residueError;
        } catch (error) {
          record.residueError = String(error?.message ?? error);
        }
      }
      const kind = returnDue(record);
      if (kind !== null || wayHomeOpen(record)) {
        try {
          if (kind !== null) await sendHome(record, kind);
          else await keepWayHome(record);
          delete record.residueError;
        } catch (error) {
          record.residueError = String(error?.message ?? error);
        }
      }
      ticked += 1;
      await saveJobs();
    }
    return { ticked, busy: false };
  } finally {
    ticking = false;
  }
}
