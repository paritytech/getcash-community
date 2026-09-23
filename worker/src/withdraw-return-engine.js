import { toSchnorrkelSecret } from "@getsome/ephemeral";
import {
  DEFAULT_SUBMIT_TIMEOUT_MS,
  DEFAULT_TICK_TIMEOUT_MS,
  discoverPool,
  DEFAULT_KEEP_NATIVE_FOR_FEES,
  DEFAULT_REMOTE_FEE_BUFFER,
  DEFAULT_SLIPPAGE_PCT,
  freshTickState,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  tickOnce,
} from "@getsome/funding";
import { CASH_SETTLEMENT, createPeopleChainPort } from "@getsome/people";
import {
  paymentResolved,
  readBurnerOnAssetHub,
  residueWorthReturning,
  restoreWithdrawTickState,
} from "@getsome/withdraw";
import { PaymentTopUpErr, PaymentTopUpStatusErr } from "@novasamatech/host-api";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { readTopUpStatus, registerTopUp } from "./host.js";
import { asBig, bounded, connectChain, keypairFor, signOptionsFor, toHex } from "./shared.js";

// The residue return, and the unwind: what is left on a withdrawal's burner once the provider
// leg is over belongs to the seller, and this drives it home through the funding pipeline the
// deposit side already exercises in production (`@getsome/funding`'s `tickOnce`, driven the same
// way `worker/src/engine.js` drives it) -- native on Asset Hub, swapped to CASH, teleported to
// People, and claimed into the purse with the same host top-up call `engine.js` makes. Nothing
// about that journey is reimplemented here; only the parts specific to a WITHDRAWAL's burner are:
// deciding whether a job is even a candidate, the floor below which returning is not worth it,
// and a claim step that keeps the residue's own id rather than chasing a partial credit across
// fresh ones the way a funded deposit's claim does (see `followReturnClaim` for why that
// simplification is safe here and would not be for a deposit).
//
// SHARES `withdraw-engine.js`'s JOB STORE, NOT A COPY OF IT. `createWithdrawReturnDriver` takes
// the SAME `loadJobs`/`saveJobs`/`saveJobsStrict` closures `withdraw-engine.js` already has
// instantiated over `getsome.withdraw.jobs`, rather than opening a second `createJobStore` on the
// same storage key. Two independent in-memory caches over one key would each write back their own
// stale snapshot of the OTHER'S changes -- a whole-blob read-modify-write race that would lose
// updates to jobs the other engine touched, not just to this one's own fields. Sharing the same
// cache makes that impossible: every mutation lands on the one object both drivers hold, so a
// save from either always carries what the other has done so far. The two drivers still touch
// disjoint records at any moment (see `eligibleForReturn` below), so nothing here contends with
// `tickAllWithdraw` for the same job's own fields.
//
// THE GATE THAT MUST HOLD BEFORE ANYTHING SIGNS: `paymentResolved`, read from the SAME
// `WithdrawTickState` `withdrawTickOnce` mutates -- see `packages/withdraw/src/tick.ts`'s header,
// contract 3 and its corollary (contract 4). `eligibleForReturn` below is a cheap filter over job
// status (done, or failed for a reason other than "unresolved") that decides which records are
// even LOOKED at; it is not the proof. The proof is `paymentResolved`, checked fresh every time a
// record without a `return` yet is first touched, and once cleared the record is marked
// `returnStarted` BEFORE anything else happens -- durably, with `saveJobsStrict`, so a crash
// between the mark and its persist cannot leave a record that looks untouched to `rearm` in
// withdraw-engine.js while a return has, in fact, already begun.
//
// OFF THE CRITICAL PATH. Nothing here can make a sale fail: it only ever touches a withdrawal
// already at rest (`record.done` or `record.phase === "failed"`), and it never writes `phase`,
// `done`, `failure` or the payment's own `lastError` -- only `returnStarted` and its own `return`
// object. A failure here is recorded on `record.return.lastError` and retried on the next pass,
// with no bound of its own: there is nothing this needs to give up on, unlike the payment leg,
// which answers to the session clock. That clock covers the payment; it does not cover this.

/** Not a real settle target -- `tickOnce` converts and moves the WHOLE native balance regardless
 *  of what this is set to (see `packages/funding/src/pipeline.ts`'s header: "EVERYTHING THE
 *  BURNER HOLDS IS CONVERTED AND MOVED"). It exists only to tell `tickOnce` when to call itself
 *  "done": the smallest positive amount, so landing ANY CASH at all closes the loop, rather than
 *  chasing a size nobody can know ahead of a sale whose output floats the same way the original
 *  one did. */
const SWEEP_TARGET_PLANCK = 1n;

/** Minimum wait before a claim registration or a stalled follow is retried. Mirrors
 *  `CLAIM_RETRY_MS` in engine.js; this return has no attempt cap to go with it (see the module
 *  header), so a cooldown is the only thing standing between a stuck claim and hammering the
 *  host every pass. */
const RETURN_CLAIM_RETRY_MS = 180_000;
/** Timeout for one host top-up call or status read. */
const RETURN_CLAIM_TIMEOUT_MS = 45_000;

/** Whether `record` is a candidate for a return pass right now. Only a meld rail ever lands
 *  anything on its own burner -- a self-custody withdrawal's XCM pays the real destination
 *  directly, so there is never anything here to sweep. A job still being paid (neither `done` nor
 *  `failed`) is never a candidate: touching it before then is exactly what contract 3 in
 *  tick.ts's header forbids, and `tickReturnRecord`'s own gate is what actually enforces that --
 *  this is the filter that decides what gets asked, not the answer. `failure === "unresolved"` is
 *  excluded for the same reason the gate would refuse it anyway: whether the provider was paid is
 *  undecided, and a return must not act while that is true.
 */
function eligibleForReturn(record, recordVersion) {
  if (record?.v !== recordVersion) return false;
  if (record.rail !== "meld") return false;
  // `left-below-floor` and `returned` are treated as permanent, and as things stand they are:
  // nothing on this account ever grows a balance the return did not itself put there once its
  // own conversion is done, and nothing re-checks a floor decision once made. That is a
  // statement about what this code does today, not a law -- a fee refund, a stray credit, or a
  // future floor re-check landing here would need this filter to admit the record again, and
  // whoever adds one has to widen this condition on purpose rather than relying on it decaying
  // quietly.
  if (record.return) return record.return.phase !== "left-below-floor" && !record.return.returned;
  if (record.done === true) return true;
  return record.phase === "failed" && record.failure !== "unresolved";
}

const freshReturnState = () => ({
  attempts: 0,
  xcmSubmitted: false,
  peopleAtXcm: "0",
  fundsSeenAt: null,
});

/** `reason` records, honestly, which journey this was: `"residue"` when the provider was paid and
 *  this is what quantisation and the drift buffer left over, `"unwind"` when the sale ended with
 *  no payment at all and the whole balance is coming home. A reader must not report the unwind
 *  case as a completed sale -- the seller got CASH back, not fiat. `phase` starts at
 *  `"checking-floor"`: claiming the record (see `claimForReturn`) happens before any chain call,
 *  so the floor decision genuinely has not been made yet when this is built. */
const freshReturnRecord = (reason, nowMs) => ({
  reason,
  phase: "checking-floor",
  state: freshReturnState(),
  claim: null,
  returned: false,
  returnedAmount: null,
  nativeSeen: null,
  startedAt: nowMs,
  txs: [],
});

/**
 * Wires the return driver to `withdraw-engine.js`'s own job store. `loadJobs`/`saveJobs` MUST be
 * the same closures that module already instantiated over `getsome.withdraw.jobs` -- see the
 * module header on why a second `createJobStore` on the same key is not safe to run alongside it.
 */
export function createWithdrawReturnDriver({ loadJobs, saveJobs, saveJobsStrict, recordVersion }) {
  let ticking = false;

  /** The residue leg: `tickOnce` from `@getsome/funding`, unmodified, given the withdrawal's own
   *  burner and its own People account as both ends of the same journey a deposit takes. */
  async function tickConvert(record, ctx) {
    const pool = await bounded(
      discoverPool(ctx.assetHubApi, PASEO_UNDERLYING_ASSET_ID),
      DEFAULT_TICK_TIMEOUT_MS,
      "pool discovery (return)",
    );
    const state = freshTickState();
    state.attempts = record.return.state.attempts;
    state.xcmSubmitted = !!record.return.state.xcmSubmitted;
    state.peopleAtXcm = asBig(record.return.state.peopleAtXcm);
    state.fundsSeenAt = record.return.state.fundsSeenAt ?? null;

    let outcome;
    try {
      outcome = await tickOnce(
        {
          api: ctx.assetHubApi,
          peopleApi: ctx.peopleApi,
          pool,
          address: ctx.key.address,
          signer: ctx.key.signer,
          beneficiaryHex: toHex(ctx.key.publicKey),
          settleAmount: SWEEP_TARGET_PLANCK,
          peopleParaId: record.peopleParaId,
          // The Asset Hub this worker is built for, the same one CASH_SETTLEMENT points at --
          // engine.js reasons the same way rather than trusting a per-job field.
          assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
          remoteFeeBuffer: DEFAULT_REMOTE_FEE_BUFFER,
          keepNativeForFees: DEFAULT_KEEP_NATIVE_FOR_FEES,
          slippagePct: DEFAULT_SLIPPAGE_PCT,
          tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
          submitTimeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS,
          signOptions: await signOptionsFor(ctx.ahClient),
          readUnderlyingOnPeople: (ss58) => ctx.peoplePort.settlementBalance(ss58, CASH_SETTLEMENT),
          now: Date.now,
          onBeforeSubmit: async (call) => {
            record.return.submitting = { call, at: Date.now() };
            await saveJobs();
          },
          onTx: (info) => {
            delete record.return.submitting;
            record.return.txs.push(info);
          },
          onTransientError: (error) => {
            record.return.lastError = String(error?.message ?? error);
          },
        },
        state,
      );
    } finally {
      record.return.state = {
        attempts: state.attempts,
        xcmSubmitted: state.xcmSubmitted,
        peopleAtXcm: state.peopleAtXcm.toString(),
        fundsSeenAt: state.fundsSeenAt,
      };
    }
    delete record.return.lastError;
    delete record.return.submitting;
    record.return.phase = outcome.step;
  }

  /** Registers (or re-registers, idempotently) the CASH the residue leg landed. Sized once, the
   *  same as `engine.js`'s own claim: the amount is fixed at registration so a retried call always
   *  asks the host for the figure it may already have accepted under this id. */
  async function registerReturnClaim(record, ctx, existingClaim) {
    let amount = existingClaim?.amount;
    if (amount === undefined) {
      const held = await bounded(
        ctx.peoplePort.settlementBalance(ctx.key.address, CASH_SETTLEMENT),
        RETURN_CLAIM_TIMEOUT_MS,
        "return CASH read",
      );
      if (held === 0n) return; // nothing landed yet; the next pass checks again
      amount = held.toString();
    }
    record.return.claim = {
      id: toHex(ctx.key.publicKey),
      amount,
      attempts: (existingClaim?.attempts ?? 0) + 1,
      at: Date.now(),
    };
    await saveJobs();
    try {
      await bounded(
        registerTopUp(asBig(amount), toSchnorrkelSecret(ctx.key.secretKey), ctx.key.publicKey),
        RETURN_CLAIM_TIMEOUT_MS,
        "return topUp",
      );
    } catch (error) {
      if (!(error instanceof PaymentTopUpErr.AlreadyExists)) {
        record.return.claim.error = String(error?.message ?? error);
        throw error;
      }
    }
    delete record.return.claim.error;
    record.return.claim.registeredAt = Date.now();
  }

  /**
   * Follows a registered claim to the host's verdict. Unlike `engine.js`'s funding claim, this
   * never chases a partial credit under a fresh id: a residue is already the seller's own money
   * back, not a payment someone is waiting on with a precise figure in mind, so a partial
   * settlement is recorded honestly as `partial` and left there, and `notClaimed` retries the
   * SAME id on a cooldown rather than sizing and registering a new one. That is a real
   * simplification against what a deposit's claim needs -- a deposit's target is exact and worth
   * chasing to the unit; a swept residue is not -- and it keeps this whole module small enough to
   * read in one sitting.
   *
   * NOTHING IS LOST when this under-recovers, only left uncollected: a `claimedPartially`
   * shortfall stays as CASH on the withdrawal's own People account (`ctx.key.address`, re-derived
   * from `record.label` the same way this module derives it), the same deterministic account the
   * funding leg just teleported it to. It is recoverable by a human running the same claim this
   * function would, by hand, against that address, or by a future revision of this module that
   * decides to chase it; nothing about leaving it there destroys or strands it.
   */
  async function followReturnClaim(record, ctx) {
    let status;
    try {
      status = await readTopUpStatus(ctx.key.publicKey, RETURN_CLAIM_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof PaymentTopUpStatusErr.NotFound) {
        record.return.claim = { ...record.return.claim, registeredAt: undefined, at: 0 };
        return;
      }
      record.return.claim = { ...record.return.claim, error: String(error?.message ?? error) };
      throw error;
    }
    delete record.return.claim.error;
    record.return.claim = { ...record.return.claim, status: status.type };
    if (status.type === "claimed") {
      if (!status.finalized) return; // not yet final; follow again next pass
      record.return.returned = true;
      record.return.returnedAmount = record.return.claim.amount;
      return;
    }
    if (status.type === "claimedPartially") {
      record.return.returned = true;
      record.return.returnedAmount = status.actualClaimed.toString();
      record.return.claim.partial = true;
      return;
    }
    if (status.type === "notClaimed") {
      record.return.claim = { ...record.return.claim, registeredAt: undefined, at: Date.now() };
    }
    // Any other in-progress status: nothing to do until the next pass.
  }

  async function tickClaim(record, ctx) {
    const claim = record.return.claim;
    if (!claim || claim.registeredAt === undefined) {
      if (claim && Date.now() - claim.at < RETURN_CLAIM_RETRY_MS) return; // cooldown
      await registerReturnClaim(record, ctx, claim);
      return;
    }
    await followReturnClaim(record, ctx);
  }

  /**
   * Claims `record` for the return: THE GATE, and THE COMMIT, with NOTHING AWAITED between them.
   *
   * `paymentResolved` is read from state already sitting in memory -- no chain call needed to
   * decide it -- which is what makes this possible: the check and the write that follows it are
   * two statements with no `await` between them, and JavaScript does not preempt a synchronous
   * run of statements for anything, a concurrent `startWithdraw` call included. That is the
   * actual proof that starting a return before resolution is impossible, not merely unlikely --
   * a version of this that read the burner's balance (a real network round trip) before setting
   * `returnStarted` had a window measured in seconds where a re-sent hand-off could see
   * `returnStarted` still false and re-arm the job out from under a return already under way. An
   * earlier draft of this module had exactly that bug; the fix is this function's whole reason to
   * exist as a separate, deliberately tiny, synchronous step.
   *
   * Returns true when the record now belongs to the return (whether or not one was already
   * running), false when the gate refused and nothing was touched.
   */
  function claimForReturn(record) {
    if (record.return) return true; // already claimed by an earlier tick
    const paymentState = restoreWithdrawTickState(record.state);
    if (!paymentResolved(paymentState)) return false;
    // From here this withdrawal belongs to the return, whatever it turns out to hold. Setting
    // this is the entire commit; everything after -- deriving a key, opening a connection,
    // reading a balance -- is ordinary chain work that a crash or a slow host cannot turn back
    // into a window for `rearm` to exploit, because by the time any of it starts, this is
    // already true in memory and `saveJobsStrict` is the very next statement.
    record.returnStarted = true;
    record.return = freshReturnRecord(record.done ? "residue" : "unwind", Date.now());
    return true;
  }

  /** One tick for one candidate record: claim, connect, decide, act at most once, persist, let
   *  go. */
  async function tickReturnRecord(record) {
    const isFreshClaim = !record.return;
    if (!claimForReturn(record)) return; // the gate refused; nothing was touched, nothing to persist
    if (isFreshClaim) {
      // The FIRST await since the synchronous claim in claimForReturn. Throwing here leaves
      // `returnStarted` and `return` in memory but not on disk; a crash before a later save
      // lands means the NEXT boot re-runs `claimForReturn` from scratch, which is safe because
      // nothing has signed anything yet.
      await saveJobsStrict();
    }

    // The return signs from the SAME burner the withdrawal itself used, not a fresh key -- it is
    // the residue on THAT account, so it is re-derived from the SAME label, exactly as
    // withdraw-engine.js's own tickRecord does.
    const burnerKey = await keypairFor(record.label);
    const ahClient = await connectChain(record.assetHubGenesis, "asset hub (return)");
    let peopleClient = null;
    try {
      peopleClient = await connectChain(record.peopleGenesis, "people (return)");
      const assetHubApi = ahClient.getTypedApi(paseo_next_v2);
      const peopleApi = peopleClient.getTypedApi(paseo_people_next);
      const peoplePort = createPeopleChainPort({ client: peopleClient });
      const ctx = { key: burnerKey, assetHubApi, peopleApi, peoplePort, ahClient };

      if (record.return.phase === "checking-floor") {
        const burner = await bounded(
          readBurnerOnAssetHub(assetHubApi, record.keyPublicKeyHex),
          DEFAULT_TICK_TIMEOUT_MS,
          "burner residue read",
        );
        if (residueWorthReturning(burner.free)) {
          record.return.phase = "await-native";
        } else {
          record.return.phase = "left-below-floor";
          record.return.nativeSeen = burner.free.toString();
        }
        await saveJobsStrict();
        if (record.return.phase === "left-below-floor") return;
      }

      if (record.return.phase === "left-below-floor" || record.return.returned) return;

      if (record.return.phase !== "done") {
        await tickConvert(record, ctx);
        if (record.return.phase !== "done") return;
      }

      await tickClaim(record, ctx);
    } finally {
      try {
        peopleClient?.destroy();
      } finally {
        ahClient.destroy();
      }
    }
  }

  /**
   * Drives every candidate job one tick. A per-job error is recorded on `record.return.lastError`
   * (or left for the next pass, unrecorded, when it happened before `record.return` existed at
   * all -- nothing durable was at stake yet) and never touches the payment leg's own fields.
   */
  async function tickAllWithdrawReturn() {
    if (ticking) return { ticked: 0, busy: true };
    ticking = true;
    try {
      const all = await loadJobs();
      const live = Object.values(all).filter((record) => eligibleForReturn(record, recordVersion));
      let ticked = 0;
      for (const record of live) {
        if (!eligibleForReturn(record, recordVersion)) continue; // finished since this pass began
        try {
          await tickReturnRecord(record);
        } catch (error) {
          if (record.return) record.return.lastError = String(error?.message ?? error);
        }
        ticked += 1;
        await saveJobs();
      }
      return { ticked, busy: false };
    } finally {
      ticking = false;
    }
  }

  return { tickAllWithdrawReturn };
}
