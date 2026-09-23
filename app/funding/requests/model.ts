// The request record: the one shape a request is stored and reasoned about in, the observations
// that move it, and the constants the store and the reducer share.

import type {
  FailureKind,
  FailureStep,
  PaymentPhase,
  PaymentState,
  RefundProgress,
  SwapProgress,
  SwapStatusResult,
} from "@getsome/core";
import type { FundingStep } from "@getsome/funding";
import type { MeldDepositDisclosure } from "@getsome/meld";
import type { WithdrawStep } from "@getsome/withdraw";
import type { RequestRef } from "../../utils/request-index";
import type { FundingProgressSnapshot } from "../progress";
import { CRYPTO_SOURCE_ID, isMeldSourceId, meldMethodFor } from "../source-ids";

/** Trailing debounce per key for non-critical host writes. */
export const COALESCE_MS = 250;
/** A non-terminal record's confirmation decays after this. */
export const CONFIRMED_TTL_MS = 60_000;
/** Hidden longer than this resets the session epoch on return. */
export const HIDDEN_RESET_MS = 5_000;
/** Worker job blob poll while visible and any record is at rank 0–3. */
export const JOB_POLL_MS = 6_000;
/** Foreground Meld status poll. */
export const MELD_POLL_MS = 3_000;
/** Foreground host payment status poll, while a withdrawal awaits its payment. */
export const PAYMENT_POLL_MS = 3_000;
/** A job whose `lastTickAt` is older than this counts as stale. */
export const WORKER_STALE_MS = 30_000;
/** Wait for the worker heartbeat before a hand-off. */
export const WORKER_READY_MS = 20_000;
/** Settled records kept in the mirror, most recent first. */
export const MIRROR_SETTLED_LIMIT = 50;
/** Bound on the reads a cancel performs before acting. */
export const CANCEL_CONFIRM_MS = 8_000;
/** A cancelled record is reaped after its deadline plus this grace. */
export const TOMBSTONE_GRACE_MS = 86_400_000;
/** Route fallback when the rail gives no deposit expiry. */
export const DEFAULT_DEPOSIT_WINDOW_MS = 86_400_000;
/** A probed-empty gap number is re-read at most this often. */
export const PROBED_RECHECK_MS = 86_400_000;
/** A chain-provisional deposit-seen may revert after this. */
export const PROVISIONAL_REVERT_MS = 600_000;
/** Failure reason for a request whose deposit window lapsed. */
export const DEPOSIT_EXPIRED_REASON = "Channel expired";
/** Window for the purse's payment to reach a withdrawal's key before the request expires. */
export const PAYMENT_WINDOW_MS = 1_800_000;
/** Failure reason for a withdrawal whose payment never reached its key. */
export const PAYMENT_EXPIRED_REASON = "Payment not received";

export type RequestKey = string;
export type Kind = "top-up" | "withdrawal";
/** How much a row's status can be trusted right now: confirmed by a read in this session and
 *  still within its TTL, waiting on a running reconcile, or the cache as it was left. */
export type Freshness = "confirmed" | "reconciling" | "cached";
/** The pipeline's steps between the deposit and the claim, derived from `FundingStep`: `swap` is
 *  the one program that swaps and teleports together, `await-arrival` waits for the teleported
 *  $CASH to be credited on People. */
export type ConvertingStep = Exclude<FundingStep, "await-native" | "done">;
export type DepositSeenVia = "worker" | "chain" | "rail" | "core" | "faucet" | "pre-cancel";
/** The worker's claim as it moves: sized, registered with the host, claiming, claimed. */
export type WorkerClaimPhase = "sizing" | "registering" | "claiming" | "claimed";

/** The converting steps in pipeline order. The `satisfies` fails to compile when `FundingStep`
 *  gains or loses a step, so the order can never drift from the type. */
export const CONVERTING_STEP_ORDER = { swap: 0, "await-arrival": 1 } satisfies Record<
  ConvertingStep,
  number
>;

export const isConvertingStep = (step: string): step is ConvertingStep =>
  Object.hasOwn(CONVERTING_STEP_ORDER, step);

export type RequestStatus =
  | { kind: "awaiting-deposit" }
  | {
      kind: "deposit-seen";
      at: number;
      assurance: "provisional" | "finalized";
      via: DepositSeenVia;
    }
  | { kind: "converting"; at: number; step: ConvertingStep }
  | { kind: "claiming"; at: number }
  | { kind: "settled"; at: number }
  | { kind: "failed"; at: number; recoverable: boolean }
  | { kind: "expired"; at: number }
  | { kind: "cancelled"; at: number };

export interface RailState {
  provider: "chainflip" | "meld" | "manual";
  status: SwapProgress | "failed";
  stage: "waiting" | "received" | "processing" | "delivered" | "failed";
  delayed?: boolean;
  /** The provider's own code for the ending (`refunded`, `declined`, `unobserved`, …), when it
   *  reported one. */
  failure?: { kind: FailureKind; message: string; code?: string };
  updatedAt: number;
}

export interface RequestFailure {
  kind: FailureKind;
  step: FailureStep;
  message: string;
  recoverable: boolean;
  refunded?: boolean;
  refund?: RefundProgress;
}

/** The object `runFundingViaWorker` sends today, verbatim. */
export interface WorkerHandoffPayload {
  label: string;
  burnerAddress: string;
  depositExpiresAt: number;
  settleAmount: string;
  underlyingAssetId: number;
  peopleParaId: number;
  assetHubGenesis: string;
  peopleGenesis: string;
  remoteFeeBuffer: string;
  keepNativeForFees: string;
}

/** What the store extracts from one job in the worker's blob. */
export interface WorkerJobView {
  phase: string;
  done: boolean;
  failure?: string;
  lastError?: string;
  fundsSeenAt: number | null;
  lastTickAt: number | null;
  claim: {
    phase: WorkerClaimPhase;
    amount?: string;
    /** CASH the host minted so far. */
    credited?: string;
    /** The host's last word on the top-up. */
    status?: string;
    at: number;
  } | null;
  /** As the worker records them on either branch. */
  txs?: { call: "swap" | "xcm"; txHash: string; block?: number }[];
}

export interface TopUpRecord {
  schema: 2;
  kind: "top-up";
  ref: RequestRef;
  rev: number;
  updatedAt: number;
  // Legacy fields, kept and still written; names and meanings as in today's ActiveFlowRecord.
  startedAt: number;
  amountHuman: string;
  chain: string;
  asset: string;
  sourceAmount?: string;
  sourceSymbol?: string;
  sourceFee?: string;
  /** The provider that priced the request ("TRANSAK"), not the aggregator in front of it, and the
   *  components of `sourceFee` as the rail reported them. Persisted so a resumed request's
   *  breakdown and its reference rows read the same as the ones quoted at the start. */
  sourceProvider?: string;
  sourceTransactionFee?: string;
  sourceNetworkFee?: string;
  sourcePartnerFee?: string;
  /** The funding leg's own network fee as the quote priced it. Not a component of `sourceFee`:
   *  the rail never reported it, the app priced it. */
  sourceChainFee?: string;
  meldCountry?: string;
  meldFundingRequestId?: string;
  /** Meld fiat requests only: the provider that took the payment (Transak, Koywe, ...). The
   *  concluded journey names it, and a refund is theirs to trace. */
  meldServiceProvider?: string;
  meldSubmittedAt?: number;
  /** Demo only: when Skip was pressed, so a re-open never offers Skip again for this request. */
  depositSkippedAt?: number;
  depositAddress?: string;
  depositExpiresAt?: number;
  funded?: number;
  settledAt?: number;
  claimed?: string;
  cancelledAt?: number;
  failureReason?: string;
  refunded?: boolean;
  tradeN?: number;
  sourceId?: string;
  progress: FundingProgressSnapshot;
  // Additive fields.
  route: "crypto" | "card" | "bank";
  deposit?: {
    address: string;
    amount: string;
    formatted: string;
    assetSymbol: string;
    expiresAt: number;
  };
  deadline: { depositExpiresAt: number | null; source: "rail" | "route" };
  handoff?: WorkerHandoffPayload;
  refundAddress?: string;
  status: RequestStatus;
  rail: RailState;
  failure?: RequestFailure;
  witnesses: {
    core?: { phase: PaymentPhase; at: number };
    worker?:
      | {
          known: true;
          phase: string;
          done: boolean;
          claimPhase?: WorkerClaimPhase;
          claimStatus?: string;
          fundsSeenAt: number | null;
          lastTickAt: number | null;
          failure?: string;
          at: number;
          txs?: WorkerJobView["txs"];
        }
      | { known: false; at: number };
    provider?: { status: string; at: number };
    chain?: {
      best?: { burnerNative: string; block?: number; at: number };
      finalized?: { burnerNative: string; block?: number; at: number };
    };
    clock?: { at: number };
    conflict?: { source: "worker" | "chain" | "core"; note: string; at: number };
  };
  confirmedAt?: number;
}

// The withdrawal: the purse pays CASH to a disposable key on People, the worker moves it to Asset
// Hub as PAS, and a rail carries the PAS to the destination the user named.

/** Every withdrawal runs under a source id of this shape: the prefix and the destination's id. */
export const WITHDRAW_SOURCE_PREFIX = "wd:";
export const isWithdrawSourceId = (sourceId: string | undefined): boolean =>
  sourceId !== undefined && sourceId.startsWith(WITHDRAW_SOURCE_PREFIX);

/** The worker's steps between the payment and the arrival on Asset Hub. `pay-provider` is last
 *  and runs on Asset Hub, not People: only a withdrawal that committed an exact amount to an
 *  off-ramp provider reaches it, and the self-custody path ends at the arrival. */
export type SendingStep = Exclude<WithdrawStep, "await-cash" | "done">;
export const SENDING_STEP_ORDER = {
  swap: 0,
  convert: 1,
  "await-arrival": 2,
  "pay-provider": 3,
} satisfies Record<SendingStep, number>;
export const isSendingStep = (step: string): step is SendingStep =>
  Object.hasOwn(SENDING_STEP_ORDER, step);

/** Who saw the CASH reach the key: the worker, a chain read, the host's payment status, or the
 *  read a cancel refused on. */
export type PaidVia = "worker" | "chain" | "host" | "pre-cancel";

/** `sending` is the rail carrying the PAS from Asset Hub to the destination; a destination on
 *  Asset Hub itself has no rail and goes from converting to sent. */
export type WithdrawalStatus =
  | { kind: "awaiting-payment" }
  | { kind: "paid"; at: number; via: PaidVia }
  | { kind: "converting"; at: number; step: SendingStep }
  | { kind: "sending"; at: number }
  | { kind: "sent"; at: number }
  | { kind: "failed"; at: number; recoverable: boolean }
  | { kind: "expired"; at: number }
  | { kind: "cancelled"; at: number };

/** The leg a withdrawal left when it failed; `withdrawalRankOf` reads the rank back from it. */
export type WithdrawalFailureStep = "payment" | "convert" | "send";
export type WithdrawalFailureKind =
  | "payment-failed"
  | "rejected"
  | "timeout"
  | "expired"
  | "egress-failed"
  // The provider payment cannot be settled from the chain: possibly unpaid, possibly paid
  // twice over. Never recoverable by retrying — a person has to reconcile it.
  | "unresolved"
  | "unknown";
export interface WithdrawalFailure {
  kind: WithdrawalFailureKind;
  step: WithdrawalFailureStep;
  message: string;
  recoverable: boolean;
}

/** The host's word on a payment, as its status subscription reports it; `not-found` when the
 *  host knows nothing of the id. */
export type HostPaymentStatus =
  "processing" | "completed" | "failed" | "partiallyClaimed" | "not-found";

/** The purse's payment to the key. Each prompt is one attempt under an id the surface derives
 *  from the key and the attempt, stamped on the record before the host is asked, so the host can
 *  always be asked about it again. */
export interface HostPayment {
  attempt: number;
  requestedAt?: number;
  /** The 32-byte payment id, hex. */
  id?: string;
  status?: HostPaymentStatus;
  reason?: string;
  /** Base units the host says reached the key when it paid short. */
  actualClaimed?: string;
  updatedAt?: number;
}

/** What the worker needs to move a withdrawal, as the surface hands it over, plus what a record
 *  rebuilt from the job alone needs: the amount and the destination. */
export interface WithdrawalHandoffPayload {
  label: string;
  keyAddress: string;
  keyPublicKeyHex: string;
  /** The CASH the user asked to withdraw, base units. */
  amount: string;
  destination: { chain: string; asset: string; address: string };
  /** The Asset Hub account the PAS lands on: the rail's channel, or the destination itself. For a
   *  Meld withdrawal it is NEITHER of those — it is the BURNER'S OWN Asset Hub account, because
   *  the sale lands the PAS there before the worker pays the provider onward at
   *  `meld.providerPayoutAddress`. A reader must not take this field for the provider's address
   *  on a Meld rail. */
  landingHex: string;
  rail: WithdrawalRailState["provider"];
  assetHubGenesis: string;
  peopleGenesis: string;
  peopleParaId: number;
  assetHubParaId: number;
  poolAccount: string;
  slippagePct: number;
  paymentExpiresAt: number;
  /** Present only when `rail` is `"meld"`, and only once the sale has disclosed where to pay it:
   *  the exact amount the sale owes the provider, where to pay it, and the order key the sell
   *  session was opened under. `meldFundingRequestId`, `quotedFiatAmount`, `quotedFiatCurrency`
   *  and `cryptoCurrency` are never read by the worker's own tick — it only ever needs
   *  `committedAmount` and `providerPayoutAddress` — but ride along anyway so a surface that has
   *  lost its own record can rebuild the sale from the worker's job alone (see
   *  `recordFromWithdrawJob`), the same reason the worker persists every tick-state field
   *  generically rather than by an allow-list. */
  meld?: {
    /** The exact PAS the provider committed to receive, base units. */
    committedAmount: string;
    /** The provider's Asset Hub deposit address, SS58 — distinct from `landingHex`. */
    providerPayoutAddress: string;
    /** Key material only, matching the sell session's `orderRef`; never sent anywhere itself. */
    orderRef: string;
    /** The adapter's funding-request id; `GET /funding/:id` polls it. */
    meldFundingRequestId: string;
    /** The fiat the quote promised for `committedAmount`, and its currency. */
    quotedFiatAmount: string;
    quotedFiatCurrency: string;
    /** Meld's code for the crypto being sold, e.g. `DOT_ASSETHUB`. */
    cryptoCurrency: string;
  };
}

/**
 * The worker's own honest summary of what came back from the burner once the sale was over —
 * `describeReturn` in `worker/src/withdraw-engine.js`, read straight through. `reason` says which
 * journey this was: `"residue"` when the provider was paid and this is what quantisation and the
 * drift buffer left over, `"unwind"` when the sale ended with no payment at all and the whole
 * balance is coming home instead — a reader must not report that case as a completed sale, since
 * the seller got CASH back, not fiat. `phase` is the return's own step (`"checking-floor"` through
 * `"done"`, or `"left-below-floor"`), never the withdrawal's own `phase`/`done`/`failure`: the
 * return never writes those, on purpose (see tick.ts's header, contract 4), so this is the only
 * place a reader learns what it did.
 */
export interface WithdrawalReturnView {
  reason: "residue" | "unwind";
  phase: string;
  returned: boolean;
  returnedAmount: string | null;
  /** The balance a `left-below-floor` decision was made against; null on every other phase. */
  nativeSeen: string | null;
  claim: {
    amount: string;
    status: string | null;
    partial: boolean;
    error?: string;
  } | null;
  txs: { call: string; txHash: string; block?: number }[];
  lastError?: string;
}

/** What the store extracts from one withdrawal job in the worker's blob. */
export interface WithdrawJobView {
  phase: string;
  done: boolean;
  failure?: string;
  lastError?: string;
  fundsSeenAt: number | null;
  lastTickAt: number | null;
  txs?: { call: "swap" | "withdraw"; txHash: string; block?: number }[];
  /** Absent until the return has something to report — most of a withdrawal's life, and forever
   *  on the direct/chainflip rails, which never land anything on their own burner to sweep. */
  return?: WithdrawalReturnView;
}

/**
 * The Meld rail's own state: the sale a withdrawal committed to, and the deposit address once
 * known. `awaiting-deposit-address` is the phase before the seller's KYC concludes it;
 * `deposit-known` is entered once and never left, even when a later poll stops disclosing the
 * address (the adapter withholds it once the request concludes — see `MeldDepositDisclosure`).
 * This is the boundary the brief for this step calls out: past it, cancelling stops being safe,
 * and the worker may run the chain legs that pay the provider.
 */
export type MeldSale =
  | {
      phase: "awaiting-deposit-address";
      /** The adapter's funding-request id; `GET /funding/:id` polls it. */
      meldFundingRequestId: string;
      /** Crypto base units the sale committed the provider to receive, quantised to the
       *  provider's own precision. */
      committedAmount: string;
      /** The fiat the quote promised for `committedAmount`, and its currency. */
      quotedFiatAmount: string;
      quotedFiatCurrency: string;
      /** The provider's own last lifecycle word (`getMeldStatus`'s `raw`), once one has arrived. */
      providerStatus?: string;
      /** The deadline the surface imposes on the sale. A sell session returns no `expiresAt` of
       *  its own, so this is never read off the provider. */
      sessionExpiresAt?: number;
    }
  | {
      phase: "deposit-known";
      meldFundingRequestId: string;
      committedAmount: string;
      quotedFiatAmount: string;
      quotedFiatCurrency: string;
      providerStatus?: string;
      sessionExpiresAt?: number;
      /** Where the seller must send the crypto, as the adapter last disclosed it. */
      deposit: MeldDepositDisclosure;
    };

interface BaseRailState {
  stage: "waiting" | "delivering" | "delivered" | "failed";
  failure?: { message: string; code?: string };
  updatedAt: number;
}

/**
 * `direct` and `chainflip` carry nothing beyond the generic bookkeeping; `meld` additionally owes
 * the provider an exact amount and always carries the sale it committed to — a discriminated
 * union rather than an optional `sale` so that building a `meld` rail without one is a type
 * error, not a record a later reader has to notice is missing it.
 */
export type WithdrawalRailState =
  | (BaseRailState & { provider: "direct" | "chainflip" })
  | (BaseRailState & { provider: "meld"; sale: MeldSale });

/** Whether a Meld withdrawal has been given its deposit address: the boundary where cancelling
 *  stops being safe and the chain legs may begin. False for any other rail, which has no sale. */
export const meldDepositKnown = (rail: WithdrawalRailState): boolean =>
  rail.provider === "meld" && rail.sale.phase === "deposit-known";

export interface WithdrawalRecord {
  schema: 3;
  kind: "withdrawal";
  ref: RequestRef;
  rev: number;
  updatedAt: number;
  startedAt: number;
  /** The CASH the user asked to withdraw, human form. */
  amountHuman: string;
  /** How the withdrawal leaves: a crypto address on the `direct`/`chainflip` rails, or the payout
   *  method a Meld sale was opened for. Mirrors `FundingSelection["route"]` so the shell's own
   *  route registry and the rows it lists off `FundingTopUp.route` need no translation between
   *  the two. */
  route: "crypto" | "card" | "bank";
  /** The network and asset the funds arrive as, and where. For a Meld rail there is no address of
   *  its own to land on; `meldSellDestination` fills this in with the payout method instead. */
  destination: { chain: string; asset: string; address: string };
  /** The disposable key the purse pays: its entropy label, its People address, its public key. */
  key: { label: string; address: string; publicKeyHex: string };
  payment: HostPayment;
  deadline: { paymentExpiresAt: number };
  handoff: WithdrawalHandoffPayload;
  status: WithdrawalStatus;
  rail: WithdrawalRailState;
  failure?: WithdrawalFailure;
  /** Base units of CASH the key was seen holding, once seen. */
  paidAmount?: string;
  /** What the worker's return leg brought home from the burner, once it has something to say —
   *  see `WithdrawalReturnView`. Never read by anything that derives `status` or `failure`: this
   *  is purely informational, carried straight through from the worker's own `job.return`. */
  return?: WithdrawalReturnView;
  witnesses: {
    worker?:
      | {
          known: true;
          phase: string;
          done: boolean;
          fundsSeenAt: number | null;
          lastTickAt: number | null;
          failure?: string;
          /** The worker's last tick error, kept while a run is stuck between ticks. */
          lastError?: string;
          at: number;
          txs?: WithdrawJobView["txs"];
        }
      | { known: false; at: number };
    host?: { status: HostPaymentStatus; at: number };
    /** The Meld rail's own poll. Only its `at` is kept here — the sale's own state lives on
     *  `rail.sale` — but it is what lets a late poll be told apart from a stale one. */
    provider?: { at: number };
    chain?: {
      best?: { keyCash: string; block?: number; at: number };
      finalized?: { keyCash: string; block?: number; at: number };
    };
    clock?: { at: number };
    conflict?: { source: "worker" | "chain" | "host"; note: string; at: number };
  };
  confirmedAt?: number;
}

export type RequestRecord = TopUpRecord | WithdrawalRecord;

export const isTopUp = (record: RequestRecord): record is TopUpRecord => record.kind === "top-up";
export const isWithdrawal = (record: RequestRecord): record is WithdrawalRecord =>
  record.kind === "withdrawal";

export type Observation =
  | { source: "core"; at: number; state: PaymentState }
  | { source: "core"; at: number; claim: { stage: "prompted" | "crediting"; claimed?: string } }
  /** `job: null` means the worker has no job for the request. */
  | { source: "worker"; at: number; job: WorkerJobView | null }
  | {
      source: "provider";
      at: number;
      provider: "meld" | "chainflip";
      result: SwapStatusResult;
      delayed?: boolean;
      /** Sell only: the provider's deposit terms, on the polls that disclose them. Rides beside
       *  `result` rather than inside it for the same reason `MeldStatusView` carries it that
       *  way: it is not a status, it is an instruction the seller has to act on. */
      deposit?: MeldDepositDisclosure;
    }
  | { source: "provider"; at: number; provider: "meld"; unreachable: true }
  | {
      source: "provider";
      at: number;
      provider: "meld";
      gone: true;
      message: string;
      /** The reason this sale can no longer be completed, carried onto the record's failure.
       *  Defaults to "unobserved" (the adapter losing the request outright, a 404) when absent,
       *  which is the only caller this variant had before a bad hand-off gained one too. */
      code?: string;
    }
  | {
      source: "chain";
      at: number;
      burnerNative: string;
      finality: "best" | "finalized";
      block?: number;
      via: "probe" | "pre-cancel" | "faucet";
    }
  | { source: "clock"; at: number }
  /** A withdrawal's cancel carries no deadline: `depositExpiresAt` is 0. */
  | { source: "user"; at: number; event: "cancelled"; depositExpiresAt: number }
  | { source: "user"; at: number; event: "retry" }
  | { source: "user"; at: number; event: "meld-submitted" }
  | { source: "user"; at: number; event: "deposit-skipped" }
  // Withdrawal observations. The worker's withdrawal job, the key's CASH on People, the host's
  // word on the payment, and the surface's own prompt, stamped with its id before it goes out.
  | { source: "worker"; at: number; withdrawJob: WithdrawJobView | null }
  | {
      source: "chain";
      at: number;
      keyCash: string;
      finality: "best" | "finalized";
      block?: number;
      via: "probe" | "pre-cancel";
    }
  | {
      source: "host";
      at: number;
      payment: {
        attempt: number;
        status: HostPaymentStatus;
        reason?: string;
        actualClaimed?: string;
      };
    }
  | { source: "user"; at: number; event: "payment-requested"; attempt: number; id: string };

/** The source a request runs under: a bare legacy ref means the crypto rail's. */
export const effectiveSourceId = (ref: RequestRef): string => ref.sourceId ?? CRYPTO_SOURCE_ID;

export const routeOf = (sourceId: string): RequestRecord["route"] =>
  isMeldSourceId(sourceId) ? meldMethodFor(sourceId) : "crypto";

/** The rail a source runs on: Meld for a fiat source, the manual deposit for the crypto rail's
 *  own source, Chainflip for every other coin. */
export const railProviderOf = (sourceId: string): RailState["provider"] =>
  isMeldSourceId(sourceId) ? "meld" : sourceId === CRYPTO_SOURCE_ID ? "manual" : "chainflip";

let clock: () => number = Date.now;

/** Replaces the store's clock; tests pin time through it. */
export function setRequestsClock(fn: () => number): void {
  clock = fn;
}

/** The store's own time: the mirror stamp, the reconcile's clock observations, a flag's stamp. */
export const requestsNow = (): number => clock();

/** Forward progress on a 0 to 4 scale, per kind; a side exit keeps the rank of the leg it left. */
export function rankOf(record: RequestRecord): number {
  return record.kind === "top-up" ? topUpRankOf(record) : withdrawalRankOf(record);
}

/** A top-up: awaiting-deposit 0 < deposit-seen 1 < converting 2 < claiming 3 < settled 4. A side
 *  exit keeps the rank it left, encoded in `failure.step` as the leg the record left: the claim
 *  (`mint`) is 3, the conversion (`swap`) is 2, the deposit is 0. The reducer derives that step
 *  from the rank at the moment of failure, whatever leg the source's own failure named. */
export function topUpRankOf(record: Pick<TopUpRecord, "status" | "failure">): number {
  switch (record.status.kind) {
    case "awaiting-deposit":
      return 0;
    case "deposit-seen":
      return 1;
    case "converting":
      return 2;
    case "claiming":
      return 3;
    case "settled":
      return 4;
    case "failed":
    case "expired":
    case "cancelled":
      return record.failure?.step === "mint" ? 3 : record.failure?.step === "swap" ? 2 : 0;
  }
}

/** A withdrawal: awaiting-payment 0 < paid 1 < converting 2 < sending 3 < sent 4. A side exit
 *  keeps the rank of the leg it left: the rail (`send`) is 3, the conversion (`convert`) is 2,
 *  the payment is 0. */
export function withdrawalRankOf(record: Pick<WithdrawalRecord, "status" | "failure">): number {
  switch (record.status.kind) {
    case "awaiting-payment":
      return 0;
    case "paid":
      return 1;
    case "converting":
      return 2;
    case "sending":
      return 3;
    case "sent":
      return 4;
    case "failed":
    case "expired":
    case "cancelled":
      return record.failure?.step === "send" ? 3 : record.failure?.step === "convert" ? 2 : 0;
  }
}

export const isTerminal = (status: RequestStatus): boolean => status.kind === "settled";

/** The record reached its end: a top-up settled, a withdrawal sent. Nothing moves it again. */
export const isFinished = (record: RequestRecord): boolean =>
  record.kind === "top-up" ? record.status.kind === "settled" : record.status.kind === "sent";

/** The host took the payment, or has it in hand: such a withdrawal never expires and is never
 *  cancelled, however long the CASH takes to reach the key. */
export const paymentTaken = (record: Pick<WithdrawalRecord, "payment">): boolean => {
  const { status } = record.payment;
  return status === "processing" || status === "completed" || status === "partiallyClaimed";
};

/** The buyer has paid: the rail reports the deposit at or past `received`, or the buyer finished
 *  the provider's widget. Such a request never expires, however long the funds take to land. */
export const buyerPaid = (record: Pick<TopUpRecord, "rail" | "meldSubmittedAt">): boolean =>
  record.rail.stage === "received" ||
  record.rail.stage === "processing" ||
  record.rail.stage === "delivered" ||
  record.meldSubmittedAt !== undefined;
