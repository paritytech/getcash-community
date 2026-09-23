// The withdrawal pipeline: moves the CASH a disposable key holds on People to a destination on
// Asset Hub as PAS, in two transactions signed by the key. The host pays the key; this waits for
// that CASH, buys the PAS the fees need, sizes and proves the XCM, submits it once, and waits for
// the PAS to show on the destination.
//
// EVERYTHING THE KEY HOLDS LEAVES. The XCM is sized from the key's whole CASH balance after the
// swap, read to the unit, and the PAS left for the transaction fee's headroom is reaped with the
// account.
//
// ARRIVAL IS A BALANCE READ AT THE HEAD, like every other read here. The destination account is
// not ours, so its balance is measured against a baseline taken just before the XCM leaves, and
// the arrival is what the Asset Hub dry run said would land, less the slippage the program
// itself allows: a sale that slips further fails the program, so nothing less can be a landing.
// The key must hold no CASH too, which says the XCM executed on People; a deposit from
// elsewhere alone does not count. Nothing is followed through block history: hosts serve the
// current head and nothing older, and a run that resumes after a reload has no memory but the
// persisted state. A program that fails on Asset Hub traps its assets there and never shows on
// the destination; the run holds until the driver's bound, and the claimer named in the program
// can recover the assets.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the key's CASH and PAS and acts at most once.
// PAS on the key means the swap happened; the XCM is next. A reload resumes from the persisted
// state. A tick that throws is retried on the next tick. Terminal is a transaction rejected at
// inclusion after the dry run passed, three times over, since each rejection costs a fee and the
// same transaction will not pass on the fourth try.
//
// AN OFF-RAMP ADDS A THIRD TRANSACTION, `pay-provider`, SIGNED ON ASSET HUB. A fiat provider is
// promised an exact figure and an exchange cannot promise one, so the sale deposits to the
// burner's OWN Asset Hub account — floating there is harmless, we hold the key — and a plain
// transfer of exactly the committed figure pays the provider afterwards. Splitting it out this
// way is what makes it retryable: the sale already happened, so a failed payment costs a fee and
// nothing else. It has its own rejection counter for that reason, and it dry-runs before it
// submits like everything else here. A self-custody withdrawal has no commitment and never
// reaches this step; it still ends at `done` the moment the destination shows the PAS.
//
// PAYING THE PROVIDER TWICE IS THE WORST OUTCOME IN THIS SYSTEM: the money is gone to an address
// we do not control and no one will send it back. So a second payment is made STRUCTURALLY
// IMPOSSIBLE rather than inferred to be unnecessary.
//
// THE NONCE IS PINNED. The first attempt reads the burner's Asset Hub nonce, persists it, and
// submits at it explicitly. Every retry of that payment submits at the SAME pinned nonce. If the
// first attempt was included, the chain rejects every retry as stale, whatever we believe about
// balances: the chain arbitrates, not our reading. Inference cannot be the guard here, because a
// host serves the current head and nothing older, so there is no transaction-hash lookup to
// settle it after the fact. The pin is the guard; the readings only report.
//
// RESOLUTION, AND THE CASE THAT HAS NO ANSWER. A submit that answers is authoritative: `ok` is a
// payment (its hash is recorded and the run is over), and a dispatch failure is a nonce consumed
// for nothing, which is the ONLY circumstance in which the pin moves — forward by one, to the
// nonce the next attempt will use, never back to nothing.
// A submit whose answer is lost leaves the pin standing, and a later tick reads the account:
//
//   - the pinned nonce is still unused  -> nothing was included; retry at the same pin;
//   - the pinned nonce is used and at least the committed amount has left  -> paid, done;
//   - the pinned nonce is used and the money is still there  -> UNRESOLVED.
//
// The third case is genuinely undecidable from the head: a successful payment whose proceeds a
// later credit has masked looks exactly like an included failure. It is NOT treated as unpaid.
// The run stops with PaymentUnresolvedError for a human to reconcile, because guessing either way
// risks a second payment or an abandoned one.
//
// THE SECOND CASE IS A CONCLUSION, NOT A CONFIRMATION, AND SAYS SO. "the pinned nonce is used and
// at least the committed amount has left" is the strongest evidence this code will ever have
// without an answered submit, but it is still an inference from a balance, not a hash the chain
// handed back — `paidTxHash` stays null, because a fabricated hash is a lie the next reader would
// chase. `paidByInference` records that this is how the run ended, and `paymentResolved` treats
// it the same as an answered payment: the alternative is a withdrawal that reads `done` forever
// while `paymentResolved` stays false forever, which is not caution, it is a residue with nobody
// left to return it. Nothing about this weakens contract 3 below — it does not become SAFER for
// something else to sign here because the inference is generous, it is simply what the state
// honestly says happened once resolution is no longer in question.
//
// THE PIN CANNOT BE THE ONLY GUARD, BECAUSE THE PIN CAN BE LOST. A write that never lands, or a
// second driver in another tab whose memory never had it, both produce a tick holding no pin
// while a payment is already on the chain; pinning a FRESH nonce there would be accepted and pay
// twice. So the pin is backed by an invariant the chain itself carries: the provider payment is
// the FIRST and only transaction the burner ever signs on Asset Hub. The sale arrives as an XCM
// deposit, which spends nobody's nonce, so an unpaid burner stands at nonce zero. A tick that
// finds no pin recorded and a nonce above zero therefore knows something already signed from
// this account, and the only thing that can be is a payment whose pin was lost. It refuses,
// rather than taking a pin the chain would honour. The balance reading is not what saves us
// there, and is not asked to be.
//
// FOUR CONTRACTS THE REST OF THE SYSTEM MUST HONOUR, all of which this reasoning depends on:
//
//   1. SINGLE WRITER — A PRECONDITION OF `withdrawTickOnce`, not an aspiration. One tick at a
//      time per withdrawal, across tabs and processes as well as within one. `payProvider`
//      re-checks its own state across every await and fails loudly if another writer moved it,
//      and the first-nonce invariant above stops a diverged second writer from paying, but two
//      writers will still fight over the record and one will end in PaymentUnresolvedError.
//      The storage this ships on offers no compare-and-set, so a lease here could only be
//      advisory; the honest answer is the precondition plus a test that pins the behaviour.
//   2. THE PIN'S WRITE MUST BE DURABLE BEFORE THE BROADCAST. `onBeforeSubmit` is where the
//      driver persists, and it must THROW if the write did not land: this code treats a throw
//      there as "do not send", which is the only reason a best-effort persist cannot lose a pin
//      out from under a transaction already in flight.
//   3. NOTHING ELSE SIGNS ON ASSET HUB FROM THE BURNER, BEFORE THE PAYMENT OR UNTIL IT IS
//      RESOLVED. The later residue return signs from this same account; before, it would break
//      the first-nonce invariant, and after, it would consume the pin so that "the pin was used"
//      no longer means "our payment was included" — it could even move more than the committed
//      amount and read as a payment that never happened. `paymentResolved` is the exported
//      predicate that step must gate itself on.
//   4. AND ONCE THE RETURN HAS SIGNED, THIS WITHDRAWAL MUST NEVER REACH `withdrawTickOnce` AGAIN.
//      BURNER_FIRST_NONCE's reasoning — a bare nonce with no pin recorded can only be a lost
//      payment — is sound only as long as `payProvider` is the sole thing that has ever signed
//      from the burner. A return leg that has moved the residue (or, on a sale that never paid,
//      the whole balance) has by then signed from the SAME account, so a later tick reading "no
//      pin, nonce above zero" could no longer tell a lost payment from an ordinary return having
//      done its job — the two are indistinguishable from the head, the same way the pin's own
//      third case is. This code does not attempt to tell them apart, because it cannot: contract
//      3 already establishes that nothing else may sign here before resolution, so the only
//      sound position afterward is that nothing ever calls `withdrawTickOnce` again for this
//      withdrawal. That is not this module's to enforce — it has no visibility into a return it
//      never drives — so it falls to whoever holds the record: once a return has started, that
//      fact must be recorded durably and independent of chain state (not inferred from `done` or
//      a `failed` phase alone, since a retried hand-off is exactly the thing that re-arms a
//      failed job), and a re-arm must refuse a job that carries it, permanently, the same way it
//      already refuses one left `PaymentUnresolvedError`-failed.

import type { PolkadotSigner } from "polkadot-api";
import { describeDispatchError, signedOrigin } from "@getsome/funding";
import { assetHubAddressFor } from "./destination";
import { PEOPLE_TX_OPTIONS } from "./paseo";
import {
  assetHubPaymentOverhead,
  NeedsSwapError,
  sizeSwap,
  sizeXcm,
  type AssetHubApi,
} from "./fees";
import {
  buildProviderPayment,
  buildSwap,
  buildWithdrawXcm,
  withdrawMessage,
  type PeopleApi,
} from "./program";

/** 'swap' buys the PAS the fees need; 'convert' submits the XCM; 'await-arrival' holds while the
 *  PAS has not shown where the sale was sent; 'pay-provider' transfers the committed amount on
 *  Asset Hub, and only an off-ramp ever reaches it. */
export type WithdrawStep =
  "await-cash" | "swap" | "convert" | "await-arrival" | "pay-provider" | "done";

/** The exact amount an off-ramp owes a fiat provider, and where it is owed. Absent for a
 *  self-custody withdrawal, which pays no one and floats freely. */
export interface WithdrawCommitment {
  /** The figure the provider was quoted, planck, exactly as it must arrive. */
  planck: bigint;
  /** The provider's Asset Hub deposit address, SS58. */
  payoutAddress: string;
}

/** Bound on a tick's chain reads and dry runs. */
export const DEFAULT_WITHDRAW_TICK_TIMEOUT_MS = 30_000;
/** Bound on a submitted transaction's resolution. */
export const DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS = 180_000;
/** Headroom below the quoted sale on Asset Hub before the program fails there. */
export const DEFAULT_WITHDRAW_SLIPPAGE_PCT = 5;
/** Rejections at inclusion after a passing dry run before the run is given up. */
export const MAX_REJECTIONS = 3;
/** Submits of the provider payment before it is left for a human. Retries at the pinned nonce
 *  cannot double-pay, but a payment that will not resolve is a fault, not a thing to loop on. */
export const MAX_PAY_ATTEMPTS = 5;
/** The nonce a burner that has never signed on Asset Hub stands at. The provider payment is the
 *  first transaction it ever signs there, so anything above this with no pin recorded is a
 *  payment we have lost track of, not a fresh start. */
export const BURNER_FIRST_NONCE = 0;
/** The least the destination must gain for the PAS to count as arrived: the dry run's landing
 *  less the slippage the program allows the sale, since a sale that slips further fails the
 *  program on Asset Hub and lands nothing. */
export const landingFloor = (landed: bigint, slippagePct: number): bigint =>
  landed - (landed * BigInt(Math.round(slippagePct * 100))) / 10_000n;

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The transactions this tick signs: the first two on People, the last on Asset Hub. */
export type WithdrawCall = "swap" | "withdraw" | "pay-provider";

/** Terminal: the chain rejected the transaction at inclusion MAX_REJECTIONS times after its dry
 *  run passed each time. Something the dry run cannot see differs at inclusion. */
export class WithdrawRejectedError extends Error {
  constructor(
    readonly call: WithdrawCall,
    readonly reason: string,
  ) {
    super(`withdrawal given up: ${call} rejected ${MAX_REJECTIONS} times, last: ${reason}`);
    this.name = "WithdrawRejectedError";
  }
}

/** Terminal: whether the provider was paid cannot be decided from the chain's head, or the
 *  payment has been attempted to its bound without resolving. A human has to look. Deliberately
 *  not a failure and not a success: the one thing that must not happen is a guess in either
 *  direction, so the run stops here and the pinned nonce keeps a retry from paying twice. */
export class PaymentUnresolvedError extends Error {
  constructor(readonly detail: string) {
    super(`withdrawal payment unresolved, needs reconciliation: ${detail}`);
    this.name = "PaymentUnresolvedError";
  }
}

/** Cross-tick memory for one withdrawal. The driver persists it; `withdrawTickOnce` mutates it. */
export interface WithdrawTickState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** Rejections at inclusion so far. */
  rejections: number;
  /** Set once the XCM landed on People; holds the run in await-arrival. */
  submitted: boolean;
  /** The destination's PAS on Asset Hub read just before the XCM left; what the arrival adds to. */
  destinationPasBefore: bigint | null;
  /** PAS the Asset Hub dry run credited to the destination, for the XCM that left. */
  expectedLanding: bigint | null;
  /** When the first tick saw CASH (ms); null while the payment is still awaited. */
  fundsSeenAt: number | null;
  /** Submits of the provider payment so far, rejected and unanswered ones included. Bounded by
   *  MAX_PAY_ATTEMPTS, past which the payment is left for a human rather than retried forever. */
  payAttempts: number;
  /** Rejections of the provider payment at inclusion. Counted apart from the XCM's, because the
   *  payment is retryable by design and must not be given up on the XCM's budget. */
  payRejections: number;
  /** The burner's Asset Hub nonce PINNED for this payment: every attempt is submitted at it, so
   *  the chain rejects a retry of a payment that was already included. Null until the first
   *  attempt, and cleared only by an answered dispatch failure, which consumed it for nothing. */
  payNonce: number | null;
  /** The burner's free PAS read at the moment the pin was taken. Reporting only: it says whether
   *  the money left, which decides done against unresolved once the pin has been used. */
  payFreeBefore: bigint | null;
  /** The exact amount the pinned payment carries, so a commitment that changed underneath a
   *  payment in flight is caught rather than paid at two figures. */
  payAmount: bigint | null;
  /** The hash of a payment the chain confirmed. Authoritative: set only from an `ok` submit, and
   *  the one reading that ends the run without consulting the chain again. */
  paidTxHash: string | null;
  /** Set when the run ended `done` from the balance-inference branch — the pin was used and the
   *  balance fell by at least the commitment — rather than from an answered submit. There is no
   *  transaction hash to show for it and none is invented; this is what tells `paymentResolved`
   *  the run is over anyway, so a genuine residue is not orphaned behind a predicate that can
   *  never see resolution reach a case that never carries a hash. See the header. */
  paidByInference: boolean;
}

export const freshWithdrawTickState = (): WithdrawTickState => ({
  attempts: 0,
  rejections: 0,
  submitted: false,
  destinationPasBefore: null,
  expectedLanding: null,
  fundsSeenAt: null,
  payAttempts: 0,
  payRejections: 0,
  payNonce: null,
  payFreeBefore: null,
  payAmount: null,
  paidTxHash: null,
  paidByInference: false,
});

/** True when no provider payment is in flight: either one was confirmed (by an answered submit
 *  or, failing that, by the balance-inference branch, which `paidByInference` marks so the two
 *  are never confused for the same evidence), or none is pinned and unanswered. The residue
 *  return must not sign from the burner until this holds — it would consume the pinned nonce and
 *  destroy the evidence the payment is resolved by. `payAmount` is the marker rather than the
 *  pin, because the pin advances past an answered failure and stands at the nonce the NEXT
 *  attempt would use, with nothing in flight behind it. */
export const paymentResolved = (state: WithdrawTickState): boolean =>
  state.paidTxHash !== null || state.paidByInference || state.payAmount === null;

/** The persisted form of the tick state: the same keys, with bigints boxed so JSON round-trips
 *  them back as bigints. */
export type PersistedWithdrawTickState = Record<string, unknown>;

const isBoxedBigint = (v: unknown): v is { $bigint: string } =>
  typeof v === "object" && v !== null && typeof (v as { $bigint?: unknown }).$bigint === "string";

/**
 * The state as a driver should store it. EVERY key is written, generically: a field added to
 * WithdrawTickState is persisted without touching this function, which is the whole point —
 * a hand-written list of fields is how a field comes to be silently dropped, and the one field
 * that must never be dropped is the pinned nonce.
 */
export function serialiseWithdrawTickState(state: WithdrawTickState): PersistedWithdrawTickState {
  return Object.fromEntries(
    Object.entries(state).map(([k, v]) => [k, typeof v === "bigint" ? { $bigint: `${v}` } : v]),
  );
}

/** The bigint fields of the state as it was stored BEFORE the boxing above: bare decimal
 *  strings. A closed, historical set — nothing new goes in here, because everything written
 *  since is boxed and self-describing. It exists so that a record already on a user's device
 *  keeps working, rather than being stranded behind a version bump that leaves a live
 *  withdrawal undriven. */
const LEGACY_BIGINT_KEYS = new Set(["destinationPasBefore", "expectedLanding"]);

/** The inverse. Unknown keys are dropped and missing ones take their fresh value, so a record
 *  written by an older build restores into the current shape instead of failing. */
export function restoreWithdrawTickState(raw: unknown): WithdrawTickState {
  const restored = freshWithdrawTickState() as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (!(k in restored)) continue;
    if (isBoxedBigint(v)) restored[k] = BigInt(v.$bigint);
    else if (LEGACY_BIGINT_KEYS.has(k) && typeof v === "string" && /^\d+$/.test(v)) {
      restored[k] = BigInt(v);
    } else restored[k] = v;
  }
  return restored as unknown as WithdrawTickState;
}

export interface WithdrawTickInput {
  peopleApi: PeopleApi;
  assetHubApi: AssetHubApi;
  /** The disposable key: its People SS58, its public key, its People signer, and — only for an
   *  off-ramp, which is the only thing this tick ever signs on Asset Hub — an Asset Hub signer.
   *  A self-custody caller supplies neither it nor a commitment and is unaffected. */
  key: {
    address: string;
    publicKeyHex: string;
    signer: PolkadotSigner;
    assetHubSigner?: PolkadotSigner;
  };
  /** The Asset Hub account that receives the PAS for a self-custody withdrawal, 32-byte public
   *  key hex. With a commitment the sale goes to the burner instead and this is unused. */
  destinationHex: string;
  /** The exact payment an off-ramp owes; absent for a self-custody withdrawal. */
  commitment?: WithdrawCommitment;
  /** The Asset Hub account that may claim a trapped program; defaults to the key. */
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The People pool's account, whose balances are the reserves. */
  poolAccount: string;
  slippagePct: number;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  /** Extra options merged into every submit, after People's signed extension and, for the
   *  swap, its CASH fee asset. */
  signOptions?: Record<string, unknown>;
  /** Extra options merged into the Asset Hub submit. Its fee is paid in the PAS the sale landed,
   *  so People's CASH fee asset and signed extension have no place here. */
  assetHubSignOptions?: Record<string, unknown>;
  /** The key's CASH and PAS on People. */
  readKeyOnPeople: (ss58: string) => Promise<{ cash: bigint; pas: bigint }>;
  /** The destination's free PAS on Asset Hub at the current head. */
  readDestinationOnAssetHub: (destinationHex: string) => Promise<bigint>;
  /** The burner's own Asset Hub account: free PAS and nonce. Required with a commitment, where
   *  the sale lands on an account we hold the key to and can therefore read outright. */
  readBurnerOnAssetHub?: (burnerHex: string) => Promise<{ free: bigint; nonce: number }>;
  now: () => number;
  onTx?: (info: { call: WithdrawCall; txHash: string; block?: number }) => void;
  onTransientError?: (error: unknown) => void;
  /** Persist the state; called immediately before every broadcast. MUST THROW if the write did
   *  not land — a submit that outruns its own record is how a pinned nonce gets lost and a
   *  provider gets paid twice, and a throw here stops the broadcast. */
  onBeforeSubmit?: (call: WithdrawCall) => Promise<void> | void;
  /** Persist the state at a point where losing the change would strand the run: the pin's
   *  release after an answered failure, which a crash before the next save would leave looking
   *  like an unresolvable payment. Same durability requirement as onBeforeSubmit. */
  onStateCheckpoint?: () => Promise<void> | void;
}

export interface WithdrawTickOutcome {
  step: WithdrawStep;
  balances: { cash: bigint; pas: bigint };
  /** A transaction went out and landed ok. */
  submitted: boolean;
}

/** A submit the chain refused outright rather than including. A spent nonce is the one that
 *  matters here; papi reports these as InvalidTxError, and the reasons it covers beyond
 *  staleness are all things the next tick's reading settles anyway. */
function isStaleNonce(error: unknown): boolean {
  const e = error as { name?: string; message?: string };
  return e?.name === "InvalidTxError" || /stale/i.test(e?.message ?? "");
}

/**
 * The off-ramp's last leg: pay the provider exactly what it was committed, on Asset Hub, out of
 * the sale the XCM already landed on the burner. One reading, at most one submit, and a nonce
 * pinned across every attempt so a second payment is impossible rather than merely unlikely.
 */
async function payProvider(
  input: WithdrawTickInput,
  state: WithdrawTickState,
  balances: { cash: bigint; pas: bigint },
  commitment: WithdrawCommitment,
): Promise<WithdrawTickOutcome> {
  const { key } = input;
  // Checked before the withdrawal starts, not here; this only narrows the types.
  const signer = key.assetHubSigner!;
  const readBurner = input.readBurnerOnAssetHub!;

  // The chain already told us it was paid. Nothing on the head can revise that, so no read.
  if (state.paidTxHash !== null) return { step: "done", balances, submitted: false };
  /** The pin as this invocation found it, to detect another writer across the awaits below. */
  const pinnedAtEntry = state.payNonce;

  // A commitment that moved after a payment was pinned cannot be reconciled from here: one
  // figure is in flight and another is owed.
  if (state.payAmount !== null && state.payAmount !== commitment.planck) {
    throw new PaymentUnresolvedError(
      `the commitment changed from ${state.payAmount} to ${commitment.planck} with a payment pinned`,
    );
  }

  const burner = await bounded(
    readBurner(key.publicKeyHex),
    input.tickTimeoutMs,
    "burner balance read",
  );

  // A pin that the chain has consumed means our payment was included — nothing else may sign
  // from this account before the payment resolves, which is contract 2 in the header. Whether it
  // PAID is a second question, and the balance is the only witness left at the head.
  if (state.payNonce !== null && burner.nonce > state.payNonce) {
    const moved = (state.payFreeBefore ?? 0n) - burner.free;
    if (state.payFreeBefore !== null && moved >= commitment.planck) {
      // Concluded, not confirmed: no submit answered, so there is no hash to record. See the
      // header on why `paidByInference` exists rather than leaving this indistinguishable from
      // an answered payment on one side, or leaving `paymentResolved` false forever on the other.
      state.paidByInference = true;
      return { step: "done", balances, submitted: false };
    }
    // The pin was spent and the money is still here. That is either an included failure or a
    // successful payment whose proceeds something else has since replaced, and the head cannot
    // tell them apart. Refusing to guess is the whole point.
    throw new PaymentUnresolvedError(
      `nonce ${state.payNonce} was used but only ${moved} left the burner, short of ${commitment.planck}`,
    );
  }

  // No pin, but the burner has signed something on Asset Hub. It signs exactly one thing, this
  // payment, so a pin was taken and lost — a write that never landed, or another context whose
  // memory we do not share. Taking a fresh pin here is the one move that can pay twice.
  if (state.payNonce === null && burner.nonce !== BURNER_FIRST_NONCE) {
    throw new PaymentUnresolvedError(
      `the burner is at nonce ${burner.nonce} on Asset Hub with no payment pinned: something signed from it already`,
    );
  }

  // Cheap gates first: a tick that is only waiting for the sale makes no round-trips beyond the
  // account read it has already done.
  if (balances.cash !== 0n || burner.free <= commitment.planck) {
    return { step: "await-arrival", balances, submitted: false };
  }
  const { transferFeePlanck, existentialDeposit } = await bounded(
    assetHubPaymentOverhead(input.assetHubApi, key.publicKeyHex, {
      commitPlanck: commitment.planck,
      payoutAddress: commitment.payoutAddress,
    }),
    input.tickTimeoutMs,
    "payment fee estimate",
  );
  // The burner is ours, so this is a real reading of what is there, not a gain against a
  // baseline. Until it covers the payment, its fee and the deposit that must stay behind, the
  // sale has not landed and there is nothing to pay from. The fee carries the same headroom the
  // sizing put under the sale's floor, so a fee that drifted cannot close this gate on a sale
  // that cleared that floor.
  if (burner.free < commitment.planck + transferFeePlanck + existentialDeposit) {
    return { step: "await-arrival", balances, submitted: false };
  }

  if (state.payAttempts >= MAX_PAY_ATTEMPTS) {
    throw new PaymentUnresolvedError(
      `${state.payAttempts} attempts without the payment resolving either way`,
    );
  }

  const payment = buildProviderPayment(input.assetHubApi, {
    payoutAddress: commitment.payoutAddress,
    amount: commitment.planck,
  });
  const burnerAddress = assetHubAddressFor(key.publicKeyHex);
  const dr = await bounded(
    input.assetHubApi.apis.DryRunApi.dry_run_call(
      signedOrigin(burnerAddress) as never,
      payment.decodedCall as never,
      5,
    ),
    input.tickTimeoutMs,
    "provider payment dry run",
  );
  if (!dr.success) {
    throw new Error(`not submitted: Asset Hub would not dry-run the payment (${dr.value.type})`);
  }
  if (!dr.value.execution_result.success) {
    throw new Error(
      `not submitted: Asset Hub rejects the payment: ${describeDispatchError(dr.value.execution_result.value.error)}`,
    );
  }

  // Single writer, contract 1 in the header. Several awaits have passed since the state was
  // read; if another tick moved the payment in that window, this one has no business submitting.
  if (state.payNonce !== pinnedAtEntry || state.paidTxHash !== null) {
    throw new Error("withdrawal: another tick moved the provider payment underneath this one");
  }

  // The pin. Taken once, on the first attempt, and reused verbatim by every retry: the chain
  // then refuses a retry of a payment it already included. Written before the broadcast, so a
  // submit whose answer is lost still leaves the pin a later tick can read the account against.
  const nonce = state.payNonce ?? burner.nonce;
  state.payNonce = nonce;
  if (state.payFreeBefore === null) state.payFreeBefore = burner.free;
  state.payAmount = commitment.planck;
  // Counted before the persist, so an attempt whose process dies mid-submit is in the record
  // the reload reads: an uncounted attempt is a retry the bound never sees.
  state.payAttempts += 1;
  // Throws when the write did not land, and this code does not submit what it could not record.
  await input.onBeforeSubmit?.("pay-provider");
  let res;
  try {
    res = await bounded(
      payment.signAndSubmit(signer, { ...input.assetHubSignOptions, nonce } as never),
      input.submitTimeoutMs,
      "provider payment submit",
    );
  } catch (error) {
    if (isStaleNonce(error)) {
      // The chain refused the retry because the pin is spent. That is the pin doing its job and
      // evidence that the payment we were retrying went in, not an attempt wasted — the next
      // tick reads the account and resolves it.
      state.payAttempts -= 1;
      throw new Error(
        "pay-provider: the pinned nonce is already spent; resolving on the next tick",
      );
    }
    throw error;
  }
  input.onTx?.({ call: "pay-provider", txHash: res.txHash, block: res.block?.number });
  if (!res.ok) {
    // An answer came back: the transaction was included, it paid nothing, and it consumed the
    // pin. This is the only circumstance in which the pin moves on, because it is the only one
    // where we know what became of it. The pin ADVANCES rather than clearing: clearing would
    // leave a tick with no pin facing a burner whose nonce has moved, which is the reading that
    // means "a payment was lost" and would strand a run that merely failed.
    const reason = describeDispatchError(res.dispatchError);
    state.payNonce = nonce + 1;
    state.payFreeBefore = null;
    // Nothing is in flight any more, so a commitment re-sized after this is legitimate.
    state.payAmount = null;
    state.payRejections += 1;
    // Persisted here and not at the end of the tick: a crash in between would leave the spent
    // pin stored, and the next tick would read "pin used, money still there" and refuse to
    // resolve a payment that demonstrably failed.
    await input.onStateCheckpoint?.();
    if (state.payRejections >= MAX_REJECTIONS) {
      throw new WithdrawRejectedError("pay-provider", reason);
    }
    throw new Error(`pay-provider rejected: ${reason}`);
  }
  // The chain confirmed it. Recorded so no later reading of balances can reopen the question.
  state.paidTxHash = res.txHash;
  return { step: "pay-provider", balances, submitted: true };
}

/**
 * One reading of the key and at most one action on it. Retryable by calling again; the terminal
 * signals are the returned "done", a thrown WithdrawRejectedError and a thrown
 * PaymentUnresolvedError.
 *
 * PRECONDITION: one caller at a time for a given withdrawal, across tabs and processes, with the
 * state persisted between calls by that one caller. This is a requirement, not a hope — see the
 * header. A second caller working from a diverged copy of the state cannot pay the provider
 * twice, because the first-nonce invariant catches it, but it will end that run in
 * PaymentUnresolvedError.
 */
export async function withdrawTickOnce(
  input: WithdrawTickInput,
  state: WithdrawTickState,
): Promise<WithdrawTickOutcome> {
  const { key } = input;
  // Before anything is read or signed. A commitment without the means to pay it out would
  // otherwise swap, sell and teleport first and only then discover it cannot pay — stranding the
  // whole sale on the burner with no code path able to move it.
  if (input.commitment && (!key.assetHubSigner || !input.readBurnerOnAssetHub)) {
    throw new Error(
      "withdrawal: a committed withdrawal needs an Asset Hub signer and a burner account read",
    );
  }
  const balances = await bounded(
    input.readKeyOnPeople(key.address),
    input.tickTimeoutMs,
    "tick balance read",
  );

  if (state.submitted) {
    // An off-ramp's sale landed on the burner itself, an account we can read outright, so the
    // arrival and the payment are one step and the baseline below has no part in it.
    if (input.commitment) return payProvider(input, state, balances, input.commitment);
    // The XCM left People; the PAS shows on the destination. Without the baseline the arrival
    // cannot be measured, so the run holds here until the driver's bound.
    if (state.destinationPasBefore === null || state.expectedLanding === null) {
      return { step: "await-arrival", balances, submitted: false };
    }
    const destinationPas = await bounded(
      input.readDestinationOnAssetHub(input.destinationHex),
      input.tickTimeoutMs,
      "destination balance read",
    );
    // Two signals: the key holds no CASH, which only the XCM takes in full, so it executed on
    // People; and the destination gained at least what a successful sale can land. Either alone
    // is not an arrival.
    const cashGone = balances.cash === 0n;
    const landed =
      destinationPas - state.destinationPasBefore >=
      landingFloor(state.expectedLanding, input.slippagePct);
    return { step: cashGone && landed ? "done" : "await-arrival", balances, submitted: false };
  }

  if (balances.cash === 0n) {
    // Only the XCM empties the key of both assets. Seen CASH, a submit, and now nothing: the
    // XCM landed and its answer was lost. The baseline taken before the submit still measures
    // the arrival.
    if (balances.pas === 0n && state.fundsSeenAt !== null && state.attempts > 0) {
      state.submitted = true;
      return { step: "await-arrival", balances, submitted: false };
    }
    return { step: "await-cash", balances, submitted: false };
  }
  if (state.fundsSeenAt === null) state.fundsSeenAt = input.now();

  // The swap pays in CASH; the XCM pays in PAS. Both pass People's signed extension.
  const swapOptions = { ...PEOPLE_TX_OPTIONS, ...input.signOptions };
  const xcmOptions = {
    customSignedExtensions: PEOPLE_TX_OPTIONS.customSignedExtensions,
    ...input.signOptions,
  };
  const rejected = (call: "swap" | "withdraw", reason: string): never => {
    state.rejections += 1;
    if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError(call, reason);
    throw new Error(`${call} rejected: ${reason}`);
  };

  // No PAS on the key yet: buy the fees' PAS first. PAS on the key: the swap is done, size and
  // prove the XCM. A sizing that finds the PAS short after all sends the run back to the swap.
  const needsSwap = balances.pas === 0n;
  // An exchange cannot promise the exact figure a provider was committed, so an off-ramp's sale
  // goes to the burner's own Asset Hub account and the exact payment follows separately. A
  // self-custody withdrawal sends it straight to the destination, as it always has.
  const landingHex = input.commitment ? key.publicKeyHex : input.destinationHex;
  if (!needsSwap) {
    try {
      const sizing = await bounded(
        sizeXcm({
          peopleApi: input.peopleApi,
          assetHubApi: input.assetHubApi,
          key: { address: key.address, publicKeyHex: key.publicKeyHex },
          cashOnKey: balances.cash,
          pasOnKey: balances.pas,
          destinationHex: landingHex,
          claimerHex: input.claimerHex,
          assetHubParaId: input.assetHubParaId,
          peopleParaId: input.peopleParaId,
          slippagePct: input.slippagePct,
          commitPlanck: input.commitment?.planck,
          payoutAddress: input.commitment?.payoutAddress,
        }),
        input.tickTimeoutMs,
        "withdrawal sizing",
      );
      const tx = buildWithdrawXcm(input.peopleApi, sizing.args);
      // Read before the submit, so what the XCM adds is measured from what was there. Set before
      // the driver persists, so a submit whose answer is lost keeps its baseline. An off-ramp
      // lands on an account it can read outright and measures no gain, so it skips the read
      // rather than pay for one and leave a field meaning a different account by mode.
      state.destinationPasBefore = input.commitment
        ? null
        : await bounded(
            input.readDestinationOnAssetHub(landingHex),
            input.tickTimeoutMs,
            "destination balance read",
          );
      state.expectedLanding = sizing.landed;
      await input.onBeforeSubmit?.("withdraw");
      // Counted before the broadcast, so a submit whose answer is lost is still counted.
      state.attempts += 1;
      const res = await bounded(
        tx.signAndSubmit(key.signer, xcmOptions as never),
        input.submitTimeoutMs,
        "withdrawal submit",
      );
      input.onTx?.({ call: "withdraw", txHash: res.txHash, block: res.block?.number });
      if (!res.ok) {
        rejected(
          "withdraw",
          describeDispatchError(res.dispatchError, { message: withdrawMessage(sizing.args) }),
        );
      }
      state.submitted = true;
      return { step: "convert", balances, submitted: true };
    } catch (error) {
      if (!(error instanceof NeedsSwapError)) throw error;
      input.onTransientError?.(error);
    }
  }

  const swap = await bounded(
    sizeSwap({
      peopleApi: input.peopleApi,
      key: { address: key.address, publicKeyHex: key.publicKeyHex },
      poolAccount: input.poolAccount,
      cashBalance: balances.cash,
      destinationHex: landingHex,
      claimerHex: input.claimerHex,
      assetHubParaId: input.assetHubParaId,
    }),
    input.tickTimeoutMs,
    "swap sizing",
  );
  await input.onBeforeSubmit?.("swap");
  state.attempts += 1;
  const res = await bounded(
    buildSwap(input.peopleApi, swap).signAndSubmit(key.signer, swapOptions as never),
    input.submitTimeoutMs,
    "swap submit",
  );
  input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number });
  if (!res.ok) rejected("swap", describeDispatchError(res.dispatchError));
  return { step: "swap", balances, submitted: true };
}
