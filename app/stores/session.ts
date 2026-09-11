// Session store: the only writer of flow state; screens project it. Owns quote
// orchestration, the hand-off to the worker, claim progress, and recovery.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import type { ChainflipRail, PaymentState, SourceId } from "@getsome/core";
import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { RefundKey } from "@getsome/ephemeral";
import { refundedFailure } from "../utils/recovery";
import type { FundingStep } from "@getsome/funding";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  fundingProgressSignalForSharedStep,
  progressProviderForSource,
  resolveFundingProgressSnapshot,
  type FundingProgressSignal,
  type FundingProgressSnapshot,
} from "../funding/progress";
import { createSerialRecordMutator } from "../funding/record-mutation";
import {
  createFakeMeldClient,
  createMeldClient,
  createMeldRail,
  getMeldStatus,
  NATIVE_DECIMALS,
  pickBestQuote,
  type MeldClientLike,
  type MeldQuoteRaw,
} from "@getsome/meld";
import { CASH_DECIMALS } from "@getsome/people";
import { meldPaymentMethod, resolveMeldRegion } from "~~/lib/region";
import {
  fetchCorridor,
  fetchSupportedCountries,
  methodFor,
  type SupportedCorridor,
  type SupportedCountry,
} from "~~/lib/supported";
import {
  parseRequestIndex,
  requestRefKey,
  requestRefOf,
  sameRequestRef,
  serializeRequestIndex,
  type RequestRef,
} from "../utils/request-index";
import { journeyDone } from "../utils/journey";
import { estimateSourceAmount, estimateSourceFromCash } from "~~/lib/demo-rates";
import { priceSourceLeg, type SourcePriceResult } from "~~/lib/source-price";
import { createMockCoinageSession, workerSessionId, type MockCoinageWorld } from "~~/lib/coinage";
import type { HostedCoinageWorld } from "~~/lib/coinage-live";
import { isHosted } from "~~/lib/host-account";
import { MELD_PAYMENT_STAGE } from "../funding/progress";
import { isMeldSourceId, meldSourceIdFor } from "../funding/source-ids";
import { toCashBase } from "../utils/cash";
import { fundFromFaucet, isFaucetConfigured } from "~~/lib/faucet";
import { sourceIdFor } from "~~/lib/config";

/** Stand-in address for the mock world, which never touches a chain. */
const DEV_RECIPIENT = "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9";

/** Storage key for the index of open request numbers. */
const REQUEST_INDEX_KEY = "getsome:requests";
/** Storage key for the worker's funding jobs, keyed `${sourceId}:${tradeN}`. */
const WORKER_JOBS_KEY = "getsome.funding.jobs";
/** A record's storage key. Source-qualified when the ref carries a source id, bare otherwise. */
const requestKey = (ref: RequestRef) =>
  ref.sourceId ? `getsome:request:${ref.sourceId}:${ref.tradeN}` : `getsome:request:${ref.tradeN}`;
/** A record's ref, or null when it never got a trade number. */
const recordRef = (record: ActiveFlowRecord): RequestRef | null =>
  record.tradeN === undefined ? null : requestRefOf(record.sourceId, record.tradeN);
/** Equality over optional refs; two absent refs are equal. */
const sameOptionalRef = (a: RequestRef | undefined, b: RequestRef | undefined) =>
  a === undefined || b === undefined ? a === b : sameRequestRef(a, b);

/** Persisted per request; enough to re-open it. */
interface ActiveFlowRecord {
  amountHuman: string;
  chain: string;
  asset: string;
  sourceAmount?: string;
  sourceSymbol?: string;
  /** The provider's quoted fee (Meld), in `sourceSymbol` units. */
  sourceFee?: string;
  /** The network-fee share of `sourceFee`, when the rail broke it out. */
  sourceNetworkFee?: string;
  startedAt: number;
  depositAddress?: string;
  progress?: FundingProgressSnapshot;
  tradeN?: number;
  /** Timestamp of the first deposit seen on the burner. */
  funded?: number;
  /**
   * Meld: when the buyer finished the provider widget. A re-open resumes onto the conversion
   * screen.
   */
  meldSubmittedAt?: number;
  /** Timestamp of the claim. A settled record is kept as history; nothing drives or resumes it. */
  settledAt?: number;
  /** Amount claimed, in base units. The claim sweeps the whole burner, so this can exceed the
   *  typed amount. */
  claimed?: string;
  /** Meld fiat requests only: the adapter's funding-request id, used to resume the status poll
   *  after a reload. */
  meldFundingRequestId?: string;
  /** Meld fiat requests only: the buyer country the quote was priced in. */
  meldCountry?: string;
  failureReason?: string;
  /** True when the failed swap was refunded to the request's own key. */
  refunded?: boolean;
  /** Timestamp of the user's cancel. Marks a tombstone: hidden from every list, never driven,
   *  resurrected or deleted by the sweep. */
  cancelledAt?: number;
  /** The deposit channel's expiry, captured at cancel time. Bounds the tombstone's lifetime. */
  depositExpiresAt?: number;
  /** The session's source id, which keys the burner label. Absent on old records, meaning
   *  dot-assethub. */
  sourceId?: string;
}

interface ForegroundFundingProgress {
  ref?: RequestRef;
  startedAt: number;
  snapshot: FundingProgressSnapshot;
}

/** How many settled purchases the history keeps. */
const HISTORY_LIMIT = 10;

/** How long a tombstoned request outlives its deposit window before a confirmed-empty read
 *  may delete it. */
const TOMBSTONE_GRACE_MS = 86_400_000;
/** Deposit window assumed for a record that carries no expiry. */
const DEFAULT_DEPOSIT_WINDOW_MS = 86_400_000;

/**
 * When the record's deposit window closes; falls back to the default window from the start time.
 */
const expiryOf = (record: ActiveFlowRecord) =>
  record.depositExpiresAt ?? record.startedAt + DEFAULT_DEPOSIT_WINDOW_MS;

/** True when the deposit window closed before any deposit was seen. Funded and settled
 *  records never expire. */
const isExpiredRecord = (record: ActiveFlowRecord, now: number) =>
  record.funded === undefined && record.settledAt === undefined && now > expiryOf(record);

/** Failure reason for a request whose deposit window lapsed. */
export const DEPOSIT_EXPIRED_REASON = "Channel expired";

/** Awaits `work` with a timeout, logging the stage label before and after. */
async function step<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  console.warn(`[coinage] step: ${label}...`);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s (host not responding?)`)),
      ms,
    );
  });
  try {
    const r = await Promise.race([work, timeout]);
    console.warn(`[coinage] step: ${label} done`);
    return r;
  } finally {
    clearTimeout(timer!);
  }
}

/** Asset Hub explorer link for a block. */
const ahBlockLink = (block?: number) =>
  block === undefined
    ? ""
    : ` https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fpaseo-asset-hub-next-rpc.polkadot.io#/explorer/query/${block}`;

/**
 * A request's status as the list shows it. `ready` means the worker reported the CASH claimed
 * into the purse.
 */
export type RequestStatus =
  | { kind: "waiting" }
  | { kind: "converting"; step: FundingStep }
  | { kind: "ready" }
  | { kind: "failed"; reason: string; refunded?: boolean };

/** The funding step a status implies; null when the status says nothing about the funding leg. */
function stepOf(status: RequestStatus | undefined): FundingStep | null {
  switch (status?.kind) {
    case "waiting":
      return "await-native";
    case "converting":
      return status.step;
    case "ready":
      return "done";
    default:
      return null;
  }
}

export interface QuotedView {
  send: string;
  symbol: string;
  /** The provider's total fee in `symbol` units, when the rail quotes one (Meld does). */
  fee?: string | null;
  /** The network-fee share of `fee`, when the rail breaks it out (Meld may). */
  networkFee?: string | null;
  /** Live world only: the native (DOT) budget the rail must deliver, 10-dec base units. */
  nativeAmount: bigint | null;
  sourceAsset: string | null;
  sourceChain: string | null;
}

export const useSessionStore = defineStore("session", () => {
  // Worlds and subscription (non-reactive internals)
  const mock = shallowRef<MockCoinageWorld | null>(null);
  const live = shallowRef<HostedCoinageWorld | null>(null);
  let sub: { unsubscribe(): void } | null = null;

  // Reactive projection
  const lastState = shallowRef<PaymentState | null>(null);
  const fundingStep = ref<FundingStep | null>(null);
  const fundingError = ref<string | null>(null);
  const fundingNotice = ref<string | null>(null);
  const claimStage = ref<"prompted" | "crediting" | null>(null);
  const amountHuman = ref("");
  const amountBase = ref<bigint | null>(null);
  /** Pay method: crypto (Chainflip/manual) or a Meld fiat rail (card / bank). */
  const method = ref<"crypto" | "card" | "bank">("crypto");
  /** Buyer's country for the Meld rail as an ISO code; null means the US default. */
  const meldCountry = ref<string | null>(null);
  const quoted = shallowRef<QuotedView | null>(null);
  const quoteError = ref<string | null>(null);
  /** True when the selected card or bank method is not routed for the chosen region. Not a quote
   *  failure; nothing to retry. */
  const meldMethodUnavailable = ref(false);
  /** Every Meld on-ramp country from the adapter's live catalog; null until loaded. */
  const supportedCountries = ref<SupportedCountry[] | null>(null);
  /** The selected country's corridor: its resolved fiat and the methods it routes. Null when
   *  discovery is unreachable. */
  const meldCorridor = shallowRef<SupportedCorridor | null>(null);
  /** The Meld payment's polled stage: `waiting` while the buyer is on the widget, `receiving` once
   *  the provider approved it, `complete` when settled. */
  const meldStage = ref<"waiting" | "receiving" | "complete" | "failed" | null>(null);
  /** The Meld payment is temporarily stuck (provider retrying its crypto delivery). Transient:
   *  set and cleared by the status poll, never terminal on its own. */
  const meldDelayed = ref(false);
  /** The adapter's reason for a failed Meld payment. Null unless `meldStage === 'failed'`. */
  const meldFailureMessage = ref<string | null>(null);
  /** The provider widget URL recovered when resuming a Meld request; null unless a resume found a
   *  live one. */
  const meldResumeWidgetUrl = ref<string | null>(null);
  /** True once the buyer finished in the widget, before the status poll has confirmed anything. */
  const meldSubmitted = ref(false);
  /** Latched true once the payment reached `receiving` or `complete` and the journey took over
   *  from the widget. */
  const meldHandedOff = ref(false);
  /** Latched once the settled payment has been credited to the coinage leg. */
  let meldCredited = false;
  /** The swap network's price for the selected source; `pending` while asking. */
  const sourcePrice = shallowRef<SourcePriceResult | null>(null);
  const loading = ref(false);
  const resuming = ref(false);
  const faucetState = ref<"idle" | "funding" | "sent">("idle");
  /** True while cancelTopUp runs. */
  const cancelling = ref(false);
  /** Whether a deposit has been seen for the request on screen. Restored from the record on
   *  re-open. */
  const fundsSeen = ref(false);
  /** The claimed amount; a full burner sweep, so it may exceed the typed amount. */
  const claimedBase = ref<bigint | null>(null);
  const foregroundProgress = shallowRef<ForegroundFundingProgress | null>(null);

  // Monotonic guard for async quote work. Every fetchQuote and reset bumps it; a resolution
  // with a stale token disposes what it built.
  let quoteEpoch = 0;
  let lastQuoteParams: { chain: string; asset: string } | null = null;
  // The Meld status client, captured when a Meld session is created.
  let meldStatusClient: MeldClientLike | null = null;
  // The adapter's funding-request id, which its status route answers on.
  let meldFundingRequestId: string | null = null;
  let meldPollStop: (() => void) | null = null;
  // The country the current Meld quote was priced in.
  let meldRegionCountry: string | null = null;
  /** The ref of the request on screen; set on start or re-open, cleared with the world. Null in
   *  the mock world. */
  let foregroundRef: RequestRef | null = null;

  function session() {
    return mock.value?.session ?? live.value?.session ?? null;
  }

  const phase = computed(() => lastState.value?.phase ?? null);
  /** Whether the deposit can be skipped: one is still awaited and the faucet has not paid. */
  const canSkipDeposit = computed(
    () => phase.value === "awaiting-deposit" && !fundsSeen.value && faucetState.value === "idle",
  );
  /** Where a failed swap refunds the request on screen; null on the manual rail. */
  const refundAddress = computed(() => (mock.value ?? live.value)?.refundAddress ?? null);
  /** Reads the refund key from the world on demand. */
  function revealRefundKey(): RefundKey | null {
    return (mock.value ?? live.value)?.revealRefundKey() ?? null;
  }
  /** True while a claim is in flight: the host's sheet is up, or the credit is being verified. */
  const claiming = computed(() => phase.value === "funded" || phase.value === "working");

  /** How many of the journey's five steps are done. */
  const journeyDoneCount = computed(() =>
    journeyDone({
      phase: phase.value,
      fundingStep: fundingStep.value,
      swap: lastState.value?.phase === "swapping" ? lastState.value.swap : null,
      failure: lastState.value?.phase === "failed" ? lastState.value.failure : null,
    }),
  );
  /** When each journey step landed, in ms since epoch, by step number. Not persisted. */
  const milestones = ref<Record<number, number>>({});
  watch([journeyDoneCount, lastState], ([done, state], [prevDone, prevState]) => {
    // The first state after a start or re-open is a catch-up; it stamps nothing.
    if (state === null || prevState === null || done === prevDone) return;
    const next = { ...milestones.value };
    for (let n = prevDone + 1; n <= done; n++) next[n] ??= Date.now();
    milestones.value = next;
  });

  /**
   * TODO: remove this cap once the deposit is real money. Any replacement must clear the swap
   * networks' per-asset minimums, the highest of which is around 107 CASH (BTC).
   */
  const DEMO_MAX_CASH = 200_000_000n; // 200 CASH

  function amountStatus(): "empty" | "over-cap" | "ok" {
    if (amountBase.value === null) return "empty";
    // Hosted only; the mock world is unbounded.
    if (isHosted() && amountBase.value > DEMO_MAX_CASH) return "over-cap";
    return "ok";
  }

  /** Prices the selected source for this budget in the background. Epoch-guarded. */
  function priceSelectedSource(
    chain: string,
    asset: string,
    targetNativeBase: bigint,
    epoch: number,
  ) {
    const sourceId = sourceIdFor(chain, asset);
    if (sourceId === undefined) return;
    sourcePrice.value = { kind: "pending" };
    void priceSourceLeg({ sourceId, targetNativeBase }).then((result) => {
      if (epoch === quoteEpoch) sourcePrice.value = result;
    });
  }

  function setAmount(human: string) {
    amountHuman.value = human;
    amountBase.value = toCashBase(human);
    quoted.value = null;
    sourcePrice.value = null;
    quoteError.value = null;
    meldMethodUnavailable.value = false;
  }

  /** Switch pay method; clears the current quote (the caller re-quotes). */
  function setMethod(next: "crypto" | "card" | "bank") {
    if (next === method.value) return;
    method.value = next;
    quoted.value = null;
    quoteError.value = null;
    meldMethodUnavailable.value = false;
  }

  /** Sets the Meld buyer country; clears the current quote (the caller re-quotes). */
  function setMeldCountry(code: string) {
    if (code === meldCountry.value) return;
    meldCountry.value = code;
    quoted.value = null;
    quoteError.value = null;
    meldMethodUnavailable.value = false;
  }

  function teardownWorld() {
    quoteEpoch += 1;
    stopMeldPoll();
    meldStage.value = null;
    meldDelayed.value = false;
    meldFailureMessage.value = null;
    meldResumeWidgetUrl.value = null;
    meldSubmitted.value = false;
    meldHandedOff.value = false;
    meldCredited = false;
    meldFundingRequestId = null;
    meldStatusClient = null;
    sub?.unsubscribe();
    sub = null;
    mock.value?.session.dispose();
    mock.value = null;
    live.value?.dispose(); // tears down the session (chain clients are shared, stay up)
    live.value = null;
    lastState.value = null;
    fundingStep.value = null;
    fundingError.value = null;
    fundingNotice.value = null;
    quoted.value = null;
    // Cleared with the epoch bump: a `pending` set by the outgoing quote is never resolved.
    sourcePrice.value = null;
    claimStage.value = null;
    claimedBase.value = null;
    faucetState.value = "idle";
    fundsSeen.value = false;
    milestones.value = {};
    foregroundProgress.value = null;
    foregroundRef = null;
    clearDepositExpiry();
    // No reconcile here; reset(), start(), openRequest() and boot reconcile.
  }

  /**
   * Evicts the dead cached clients; the People port re-dials on its next read and the same session
   * continues.
   */
  function reconnectChains() {
    console.warn("[coinage] chain follow died: evicting clients; the session reconnects in place");
    void import("~~/lib/host-chain").then((h) => h.evictChains());
  }

  /** Hands the on-screen request to the worker, or rejoins its run. Safe to call repeatedly. */
  function driveFunding() {
    const world = live.value;
    if (!world) return;
    const ref = foregroundRef ?? requestRefOf(world.sourceId, world.tradeN);
    fundingError.value = null;
    fundingNotice.value = null;
    // Warn level with message strings: a host logger may forward only warn and error.
    console.warn("[coinage] funding: handing off to the worker (fund the burner to begin)");
    void world
      .runFunding({
        onStep: (s) => {
          console.warn(`[coinage] funding step: ${s}`);
          // await-native after funds are known is a stale read.
          if (s === "await-native" && fundsSeen.value) return;
          fundingStep.value = s;
          // Any step past await-native means a deposit landed. Latch and persist it.
          if (s !== "await-native") fundsSeen.value = true;
          // A deposit after the window closed is still driven; clear the expiry reason.
          if (s !== "await-native" && fundingError.value === DEPOSIT_EXPIRED_REASON) {
            fundingError.value = null;
          }
          // The list shows the on-screen request alongside the others, from one source.
          setStatus(
            ref,
            s === "await-native" ? { kind: "waiting" } : { kind: "converting", step: s },
          );
          recordSharedFundingStep(ref, s);
        },
        onTransientError: (e) => {
          console.warn(
            `[coinage] funding transient: ${e instanceof Error ? e.message : String(e)}`,
          );
        },
        onTx: ({ call, txHash, block }) => {
          console.warn(
            `[coinage] funding tx: ${call} ${txHash} @ block ${block ?? "?"}${ahBlockLink(block)}`,
          );
        },
        onClaimed: (amount) => {
          console.warn(`[coinage] funding: the worker claimed ${amount} into the purse`);
          // The record first, so the list is right whatever core makes of the resume below.
          markSettled(ref, claimedOf(amount));
          // The worker claims in the tick the CASH lands. A resume re-enters probe-first and
          // isSettled answers with the worker's claim.
          world.session.resume().catch((e: unknown) => {
            console.warn(
              `[coinage] funding: resume after the claim failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        },
      })
      .catch((e: unknown) => {
        // Shortfall, a refused hand-off, no worker: the session keeps waiting; say why.
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[coinage] funding: failed: ${reason}`);
        fundingError.value = reason;
        recordFundingProgress(ref, { observation: { kind: "failed" } });
      });
  }

  // Requests that are open but not on screen. The worker drives every open request; a
  // background world only reads the worker's job back and marks the record settled on claim.
  const background = new Map<string, HostedCoinageWorld>(); // by requestRefKey
  /** What each open request is doing, taken from the funding pipeline's steps. */
  const requestStatus = ref<Record<string, RequestStatus>>({}); // by requestRefKey
  /** The open requests, refreshed by every reconcile. */
  const requestList = shallowRef<ActiveFlowRecord[]>([]);
  const setStatus = (ref: RequestRef, status: RequestStatus) => {
    requestStatus.value = { ...requestStatus.value, [requestRefKey(ref)]: status };
  };
  let reconciling: Promise<void> | null = null;
  let reconcileAgain = false;
  /**
   * The request the foreground is adopting. Not on screen yet, but not driven off screen either.
   */
  let adopting: RequestRef | null = null;

  /** Requests whose background world is still being built. */
  const building = new Set<string>(); // by requestRefKey
  /** What the last reconcile wanted driven. A build checks here before starting a pipeline. */
  let lastWanted = new Set<string>(); // by requestRefKey

  async function driveInBackground(ref: RequestRef, amount: bigint): Promise<void> {
    const key = requestRefKey(ref);
    const { tradeN, sourceId } = ref;
    if (background.has(key) || building.has(key)) return;
    building.add(key);
    try {
      const { createHostedCoinageWorld } = await import("~~/lib/coinage-live");
      // Bounded like the foreground build. The source id derives the burner under the id the
      // request was funded on.
      const world = await step(
        `create background session #${tradeN}`,
        90_000,
        createHostedCoinageWorld({
          amount,
          tradeN,
          ...(sourceId ? { sourceId: sourceId as SourceId } : {}),
        }),
      );
      // Re-check: the foreground may have adopted this request, or a later reconcile dropped it.
      if (
        background.has(key) ||
        (foregroundRef !== null && sameRequestRef(foregroundRef, ref)) ||
        (adopting !== null && sameRequestRef(adopting, ref)) ||
        !lastWanted.has(key)
      ) {
        world.dispose();
        return;
      }
      // A slot already at `done` was claimed on screen before the record could say so. Record
      // the finish instead of driving it.
      if (world.session.peek()?.phase === "done") {
        console.info(`[coinage] request #${tradeN}: already claimed, recording the finish`);
        world.dispose();
        markSettled(ref, null);
        return;
      }
      background.set(key, world);
      console.warn(`[coinage] request #${tradeN}: funding in the background`);
      void world
        .runFunding({
          onStep: (s) => {
            console.warn(`[coinage] request #${tradeN} funding step: ${s}`);
            // 'await-native' means the deposit has not arrived; everything after it means
            // money is moving.
            setStatus(
              ref,
              s === "await-native" ? { kind: "waiting" } : { kind: "converting", step: s },
            );
            recordSharedFundingStep(ref, s);
          },
          onTransientError: (e) =>
            console.warn(
              `[coinage] request #${tradeN} transient: ${e instanceof Error ? e.message : String(e)}`,
            ),
          onClaimed: (amount) => {
            console.warn(
              `[coinage] request #${tradeN}: the worker claimed ${amount} into the purse`,
            );
            markSettled(ref, claimedOf(amount));
          },
        })
        // Resolving means the worker claimed or this world was stopped; only a rejection says
        // anything about the request.
        .catch((e: unknown) => {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn(`[coinage] request #${tradeN} funding failed: ${reason}`);
          setStatus(ref, { kind: "failed", reason });
          recordFundingProgress(ref, { observation: { kind: "failed" } });
        });
    } catch (e) {
      // A background request that cannot be built is not an error the user is looking at.
      console.warn(
        `[coinage] request #${tradeN}: background driver failed to start: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      building.delete(key);
    }
  }

  function stopBackground(ref: RequestRef) {
    stopBackgroundByKey(requestRefKey(ref));
  }
  function stopBackgroundByKey(key: string) {
    const world = background.get(key);
    if (!world) return;
    background.delete(key);
    world.dispose(); // aborts its pipeline; the chain clients are shared and stay up
  }

  /** Gives every open request except the one on screen a driver. Single-flight: a caller arriving
   *  mid-run sets a flag and the run repeats with the current records. */
  function reconcileBackground(): Promise<void> {
    if (reconciling) {
      reconcileAgain = true;
      return reconciling;
    }
    reconciling = (async () => {
      try {
        if (!isHosted()) return;
        do {
          reconcileAgain = false;
          const records = await pruneHistory(await openRequests());
          requestList.value = records;
          // Apply the worker's jobs to the records before any poller is built.
          const settled = await settleFromWorkerJobs(records);
          const wanted = new Map<string, { ref: RequestRef; amount: bigint }>();
          const now = Date.now();
          for (const record of records) {
            const amount = toCashBase(record.amountHuman);
            const ref = recordRef(record);
            if (ref === null || amount === null) continue;
            if (record.settledAt !== undefined) continue; // history: finished, nothing to drive
            if (settled.claimed.has(requestRefKey(ref))) continue; // just marked settled above
            if (settled.heldBack.has(requestRefKey(ref))) continue; // failed; a reopen retries
            // On screen, or about to be: the foreground world drives it.
            if (foregroundRef !== null && sameRequestRef(foregroundRef, ref)) continue;
            if (adopting !== null && sameRequestRef(adopting, ref)) continue;
            // An unfunded request whose deposit window closed gets no driver. It is a failed
            // top-up: the status carries the reason and the record carries the failure.
            if (isExpiredRecord(record, now)) {
              setStatus(ref, { kind: "failed", reason: DEPOSIT_EXPIRED_REASON });
              if (resolvedProgress(record).failedAt === undefined) {
                recordFundingProgress(ref, { observation: { kind: "failed" } });
                recordFailureReason(ref, DEPOSIT_EXPIRED_REASON);
              }
              continue;
            }
            wanted.set(requestRefKey(ref), { ref, amount });
          }
          for (const key of [...background.keys()]) {
            if (!wanted.has(key)) stopBackgroundByKey(key);
          }
          // A status for a request that is no longer open would keep a finished row alive.
          const open = new Set(
            records.flatMap((r) => {
              const ref = recordRef(r);
              return ref === null ? [] : [requestRefKey(ref)];
            }),
          );
          for (const key of Object.keys(requestStatus.value)) {
            if (!open.has(key)) {
              const { [key]: _gone, ...rest } = requestStatus.value;
              requestStatus.value = rest;
            }
          }
          lastWanted = new Set(wanted.keys());
          // Builds run in parallel and outside this lock; `building` stops a repeat reconcile
          // from starting a second build.
          for (const { ref, amount } of wanted.values()) void driveInBackground(ref, amount);
        } while (reconcileAgain);
        // Single-flighted on its own: the sweep does chain reads outside the reconcile lock.
        void sweepTombstones();
      } finally {
        reconciling = null;
      }
    })();
    return reconciling;
  }

  /** The hosted world up to hydration, shared by the fresh-quote and resume paths. Returns null
   *  when a newer quote superseded this one. */
  async function createLiveWorld(
    epoch: number,
    tradeN?: number,
    rail?: ChainflipRail,
    sourceId?: SourceId,
  ): Promise<HostedCoinageWorld | null> {
    // No account lookup: the burner comes from the host's entropy root and the claim credits
    // whoever the host authenticated.
    const { createHostedCoinageWorld } = await import("~~/lib/coinage-live");
    // Outer bound sized above the sum of the setup's inner stage bounds.
    const world = await step(
      "create session + size budget",
      90_000,
      createHostedCoinageWorld({
        amount: amountBase.value as bigint,
        // Re-opening a request derives its burner; a new one takes the current counter.
        ...(tradeN === undefined ? {} : { tradeN }),
        // The fiat route injects a Meld rail and its source id; the crypto route leaves both unset.
        ...(rail ? { rail } : {}),
        ...(sourceId ? { sourceId } : {}),
        onClaimProgress: (stage, claimed) => {
          claimStage.value = stage;
          if (claimed !== undefined) claimedBase.value = claimed;
        },
      }),
    );
    if (epoch !== quoteEpoch) {
      world.dispose();
      return null;
    }
    await step("session hydrate", 20_000, world.session.ready);
    if (epoch !== quoteEpoch) {
      world.dispose();
      return null;
    }
    return world;
  }

  /** The quote in flight, whichever rail: start() waits for it before opening the deposit. */
  let quoting: Promise<void> = Promise.resolve();

  /**
   * The country to quote for when the buyer has chosen none. "US" routes and matches the screen's
   * default.
   */
  function effectiveMeldCountry(): string {
    return meldCountry.value ?? "US";
  }

  /** A corridor synthesized from the static region map, for when live discovery is unreachable.
   *  Bounds are blank. */
  function staticCorridor(region: { country: string; fiat: string }): SupportedCorridor {
    const methods = (["card", "bank"] as const).flatMap((cat) => {
      const pmt = meldPaymentMethod(cat, region.country);
      return pmt === null
        ? []
        : [
            {
              paymentMethodType: pmt,
              category: cat,
              min: "",
              max: "",
              currency: region.fiat,
              providers: [],
            },
          ];
    });
    return { country: region.country, fiat: region.fiat, methods };
  }

  /**
   * Builds the Meld rail for the current selection, or signals that the method is not routed for
   * the region.
   */
  async function buildMeldRail(): Promise<
    | {
        rail: ChainflipRail;
        sourceId: SourceId;
        client: MeldClientLike;
        region: { country: string; fiat: string };
        paymentMethodType: string;
        corridor: SupportedCorridor;
      }
    | { unavailable: true; corridor: SupportedCorridor }
  > {
    const uiMethod: "card" | "bank" = method.value === "card" ? "card" : "bank";
    const meldMethod = uiMethod === "card" ? "CARD" : "BANK_TRANSFER";
    const sourceId: SourceId = uiMethod === "card" ? "meld-card" : "meld-bank";
    const country = effectiveMeldCountry();
    // The live corridor is authoritative when discovery is reachable. Otherwise fall back to the
    // static region map as a whole {country, fiat} tuple with a synthetic corridor. The caller
    // assigns `meldCorridor` after its epoch guard.
    const live = await fetchCorridor(country);
    let region: { country: string; fiat: string };
    let corridor: SupportedCorridor;
    let paymentMethodType: string | null;
    if (live !== null) {
      region = { country, fiat: live.fiat };
      corridor = live;
      paymentMethodType = methodFor(live, uiMethod)?.paymentMethodType ?? null;
    } else {
      region = resolveMeldRegion(country);
      corridor = staticCorridor(region);
      paymentMethodType = meldPaymentMethod(uiMethod, region.country);
    }
    if (paymentMethodType === null) return { unavailable: true, corridor };
    const meldBaseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
    // Land the widget on the adapter's frameable return page.
    const redirectUrl = meldBaseUrl ? `${meldBaseUrl}/meld/return` : undefined;
    const baseClient = meldBaseUrl
      ? createMeldClient({
          baseUrl: meldBaseUrl,
          productId: (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
          ...(redirectUrl ? { redirectUrl } : {}),
        })
      : createFakeMeldClient();
    // Capture the funding-request id on create so the pay sheet can poll this payment's status.
    const meldClient: MeldClientLike = {
      getQuote: (r) => baseClient.getQuote(r),
      createSession: async (r) => {
        const s = await baseClient.createSession(r);
        meldFundingRequestId = s.fundingRequestId;
        return s;
      },
      getStatus: (id) => baseClient.getStatus(id),
    };
    meldStatusClient = meldClient;
    const rail = createMeldRail({
      client: meldClient,
      country: region.country,
      fiat: region.fiat,
      method: meldMethod,
      paymentMethodType,
    });
    return { rail, sourceId, client: meldClient, region, paymentMethodType, corridor };
  }

  /**
   * How much native token the rail must deliver for `cashBase` CASH, sized from one forward
   * provider quote with CASH pegged to one unit of the quote fiat. Returns null when the provider
   * has no offer for this corridor.
   *
   * Known limit: the peg is to the quote fiat, not USD; a non-USD region is off by the FX rate.
   */
  async function sizeMeldNativeBudget(
    client: MeldClientLike,
    ctx: { country: string; fiat: string; paymentMethodType: string },
    cashBase: bigint,
  ): Promise<bigint | null> {
    const fiat = Number(cashBase) / 10 ** CASH_DECIMALS;
    if (!Number.isFinite(fiat) || fiat <= 0) return null;
    const { quotes } = await client.getQuote({
      country: ctx.country,
      sourceCurrencyCode: ctx.fiat,
      // The rail's own destination code.
      destinationCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: fiat.toFixed(2),
      paymentMethodType: ctx.paymentMethodType,
    });
    const best = pickBestQuote(quotes ?? []);
    const out = Number(best?.destinationAmount);
    if (!best || !Number.isFinite(out) || out <= 0) return null;
    // Take the rate from the probe, not its output: `destinationAmount` is net of the provider's
    // fee. Dividing by the net fiat gives native per fiat; the solver adds the fee back. A quote
    // without `totalFee` is treated as fee-free.
    const paid = Number(best.sourceAmount);
    const fee = Number(best.totalFee ?? 0);
    const netFiat = Number.isFinite(fee) ? paid - fee : paid;
    if (!Number.isFinite(paid) || netFiat <= 0) return null;
    const nativePerFiat = out / netFiat;
    return BigInt(Math.ceil(fiat * nativePerFiat * 10 ** NATIVE_DECIMALS));
  }

  /** (Re)quotes the Meld rail for the current CASH amount and region. The mock world simulates
   *  settlement through the harness; the hosted world runs the rail over the real host seams. */
  function fetchMeldQuote(): Promise<void> {
    quoting = runMeldQuote();
    return quoting;
  }

  async function runMeldQuote(): Promise<void> {
    teardownWorld();
    // The record's display source: the rail, and the method as its "asset".
    lastQuoteParams = { chain: "Meld", asset: method.value === "bank" ? "Bank" : "Card" };
    const epoch = quoteEpoch;
    quoteError.value = null;
    meldMethodUnavailable.value = false;
    // Over the cap there is nothing to quote.
    if (amountBase.value === null || amountStatus() === "over-cap") {
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const built = await buildMeldRail();
      // A newer quote may have started while the corridor probe was in flight; do not clobber its
      // state.
      if (epoch !== quoteEpoch) return;
      meldCorridor.value = built.corridor;
      if ("unavailable" in built) {
        meldMethodUnavailable.value = true;
        loading.value = false;
        return;
      }
      // The country the quote is priced in; a re-open quotes the same region.
      meldRegionCountry = built.region.country;
      // Mock world: quote, session and widget are real; settlement is simulated by the harness.
      if (!isHosted()) {
        // The Meld rail egresses the native token and is sized by a native budget.
        const nativeBudget = await sizeMeldNativeBudget(
          built.client,
          { ...built.region, paymentMethodType: built.paymentMethodType },
          amountBase.value,
        );
        if (epoch !== quoteEpoch) return;
        if (nativeBudget === null) {
          quoteError.value = "No provider offers this payment method or region. Try another.";
          return;
        }
        const world = await createMockCoinageSession({
          recipient: DEV_RECIPIENT,
          amount: amountBase.value,
          sourceId: built.sourceId,
          rail: built.rail,
          nativeBudget,
        });
        await world.session.ready;
        const quote = await world.session.quote();
        if (epoch !== quoteEpoch) {
          world.session.dispose();
          return;
        }
        mock.value = world;
        const raw = quote.raw as MeldQuoteRaw;
        quoted.value = {
          send: raw.provider.sourceAmount,
          symbol: raw.context.fiat,
          fee: raw.provider.totalFee ?? null,
          networkFee: raw.provider.networkFee ?? null,
          nativeAmount: null,
          sourceAsset: null,
          sourceChain: null,
        };
        return;
      }
      // Hosted world: the same rail over the real host seams. The provider delivers DOT to the
      // burner and the funding leg swaps it to CASH.
      const world = await createLiveWorld(epoch, undefined, built.rail, built.sourceId);
      if (!world) return;
      if (world.session.peek() !== null) {
        console.info("[coinage] clearing a stale flow slot on a reused trade number");
        await step("clear previous flow", 20_000, world.session.cancel());
      }
      if (epoch !== quoteEpoch) {
        world.dispose();
        return;
      }
      const quote = await step("quote", 20_000, world.session.quote());
      if (epoch !== quoteEpoch) {
        world.dispose();
        return;
      }
      live.value = world;
      const raw = quote.raw as MeldQuoteRaw;
      quoted.value = {
        send: raw.provider.sourceAmount,
        symbol: raw.context.fiat,
        fee: raw.provider.totalFee ?? null,
        networkFee: raw.provider.networkFee ?? null,
        nativeAmount: null,
        sourceAsset: null,
        sourceChain: null,
      };
    } catch (e: unknown) {
      if (epoch !== quoteEpoch) return; // a newer quote owns the state now
      console.error("[meld] quote failed:", e);
      quoted.value = null;
      quoteError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (epoch === quoteEpoch) loading.value = false;
    }
  }

  /** (Re)quote for the current CASH amount: fresh session per quote (budget immutable). */
  function fetchQuote(chain: string, asset: string, isRetry = false): Promise<void> {
    // A fiat method has no chain/asset to quote: its own path owns the region and the rail.
    if (method.value !== "crypto") return fetchMeldQuote();
    quoting = runQuote(chain, asset, isRetry);
    return quoting;
  }

  async function runQuote(chain: string, asset: string, isRetry: boolean): Promise<void> {
    teardownWorld();
    lastQuoteParams = { chain, asset };
    const epoch = quoteEpoch;
    quoteError.value = null;
    // Over the cap there is nothing to quote.
    if (amountBase.value === null || amountStatus() === "over-cap") {
      loading.value = false;
      return;
    }
    loading.value = true;
    console.info(
      `[coinage] quoting in the ${isHosted() ? "LIVE (hosted)" : "MOCK (browser)"} world`,
    );
    try {
      if (isHosted()) {
        const world = await createLiveWorld(epoch);
        if (!world) return; // superseded by a newer quote
        if (world.session.peek() !== null) {
          // A new request found a slot: its trade number was reused after a failed counter
          // claim. Clear the stale slot without resuming.
          console.info("[coinage] clearing a stale flow slot on a reused trade number");
          await step("clear previous flow", 20_000, world.session.cancel());
        }
        if (epoch !== quoteEpoch) {
          world.dispose();
          return;
        }
        const quote = await step("quote", 20_000, world.session.quote());
        if (epoch !== quoteEpoch) {
          world.dispose();
          return;
        }
        live.value = world;
        quoted.value = {
          send: quote.source.formatted,
          symbol: quote.source.assetSymbol,
          nativeAmount: quote.source.amount,
          sourceAsset: asset,
          sourceChain: chain,
        };
        priceSelectedSource(chain, asset, quote.source.amount, epoch);
      } else {
        const sourceId = sourceIdFor(chain, asset);
        if (!sourceId) {
          loading.value = false;
          return;
        }
        const world = await createMockCoinageSession({
          recipient: DEV_RECIPIENT,
          amount: amountBase.value,
          sourceId,
        });
        await world.session.ready;
        const quote = await world.session.quote();
        if (epoch !== quoteEpoch) {
          world.session.dispose();
          return;
        }
        mock.value = world;
        // Real pricing outside the host: the pool leg is a public chain read over a standalone
        // WebSocket. Skipped in node test runs; falls back to demo rates when the RPC is
        // unreachable.
        let nativeAmount: bigint | null = null;
        const settleForPricing = amountBase.value; // non-null: guarded at fetchQuote entry
        if (typeof window !== "undefined" && settleForPricing !== null) {
          try {
            const [
              { connectChain, ASSET_HUB },
              {
                sizeNativeBudget,
                DEFAULT_KEEP_NATIVE_FOR_FEES,
                DEFAULT_REMOTE_FEE_BUFFER,
                PASEO_UNDERLYING_ASSET_ID,
                PASEO_PEOPLE_PARA_ID,
              },
              { estimateFundingSizing },
            ] = await Promise.all([
              import("~~/lib/host-chain"),
              import("@getsome/funding"),
              import("~~/lib/funding-fees"),
            ]);
            const client = await connectChain(ASSET_HUB);
            // Size the deposit from live public reads. Best effort; falls back to the defaults.
            const sizing = await step(
              "funding sizing estimate (public read)",
              20_000,
              estimateFundingSizing({
                ahClient: client,
                underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
                peopleParaId: PASEO_PEOPLE_PARA_ID,
                settleAmount: settleForPricing,
                probeAddress: DEV_RECIPIENT,
              }),
            ).catch(() => null);
            const keepNativeForFees = sizing?.keepNativeForFees ?? DEFAULT_KEEP_NATIVE_FOR_FEES;
            const remoteFeeBuffer = sizing?.remoteFeeBuffer ?? DEFAULT_REMOTE_FEE_BUFFER;
            nativeAmount = await step(
              "pool quote (public read)",
              30_000,
              (async () =>
                sizeNativeBudget({
                  client,
                  underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
                  settleAmount: settleForPricing,
                  remoteFeeBuffer,
                  keepNativeForFees,
                }))(),
            );
          } catch (e) {
            console.warn("[coinage] live pool pricing unavailable, using demo rates:", e);
          }
        }
        if (epoch !== quoteEpoch) {
          world.session.dispose();
          return;
        }
        // The fake rail returns a fixed quote regardless of source; show a source-appropriate
        // estimate.
        const cfg = SOURCE_CONFIG_BY_ID.get(sourceId);
        const est =
          cfg && amountBase.value !== null
            ? estimateSourceFromCash(amountBase.value, cfg.asset)
            : null;
        quoted.value = {
          send: est ?? quote.source.formatted,
          symbol: est && cfg ? cfg.asset : quote.source.assetSymbol,
          nativeAmount,
          sourceAsset: est && cfg ? cfg.asset : null,
          sourceChain: chain,
        };
        // The swap network's quote endpoint is public; it needs the pool figure above as its
        // target.
        if (nativeAmount !== null) priceSelectedSource(chain, asset, nativeAmount, epoch);
      }
    } catch (e: unknown) {
      if (epoch !== quoteEpoch) return; // a newer quote owns the state now
      const msg = e instanceof Error ? e.message : String(e);
      // A dead chainHead follow poisons the cached clients. Reconnect and retry once.
      if (/disjointed/i.test(msg) && !isRetry) {
        console.warn("[coinage] chain follow died: reconnecting and retrying the quote");
        const { evictChains } = await import("~~/lib/host-chain");
        evictChains();
        return fetchQuote(chain, asset, true);
      }
      console.error("[coinage] quote failed:", e);
      quoted.value = null;
      quoteError.value = msg;
    } finally {
      if (epoch === quoteEpoch) loading.value = false;
    }
  }

  /** Open the deposit for the quoted purchase. Waits for a quote in flight; a no-op without one. */
  async function start(): Promise<void> {
    await quoting;
    const world = mock.value ?? live.value;
    if (!world || !quoted.value) return;
    // The channel refunds to this request's own key on the source chain; a rail with no refund
    // leg gets none.
    const { refundAddress } = world;
    const startedAt = Date.now();
    milestones.value = { 1: startedAt };
    fundsSeen.value = false; // a fresh request genuinely awaits its first deposit
    // The request's identity for every record write from here on (null in the mock world).
    foregroundRef = live.value ? requestRefOf(live.value.sourceId, live.value.tradeN) : null;
    const ref = foregroundRef ?? undefined;
    foregroundProgress.value = {
      ...(ref === undefined ? {} : { ref }),
      startedAt,
      snapshot: initialProgress(startedAt),
    };
    sub?.unsubscribe();
    sub = world.session.subscribe((state) => {
      observePaymentState(state, ref);
    });
    await world.session.start(refundAddress === null ? {} : { refundAddress });
    await persistActiveFlow(startedAt);
    driveFunding();
    // This request is now on screen; anything else open goes back to being driven off screen.
    void reconcileBackground();
  }

  /** Abandon the CASH flow (dest switched away / start over). */
  function reset() {
    // Retire a finished flow's slot. A no-op unless the flow reached done.
    void live.value?.session.clear().catch(() => {}); // storage hiccup: a dead slot is harmless
    teardownWorld();
    loading.value = false;
    quoteError.value = null;
    resuming.value = false;
    method.value = "crypto";
    // The record survives: its burner may hold funds. The request picks up a background driver
    // here.
    void reconcileBackground();
  }

  // Resume across reloads. The record lives on the host's app-scoped storage when hosted, and
  // in plain localStorage in standalone browser mode.
  interface KeyedStorage {
    read(key: string): Promise<string | null>;
    write(key: string, value: string): Promise<void>;
    clear(key: string): Promise<void>;
  }
  let recordStorage: KeyedStorage | null = null;
  async function flowRecordStorage(): Promise<KeyedStorage> {
    if (recordStorage) return recordStorage;
    if (isHosted()) {
      const { getHostLocalStorage } = await import("@parity/product-sdk-host");
      const host = await getHostLocalStorage();
      if (!host) throw new Error("host storage unavailable");
      recordStorage = {
        // The host SDK reads an absent key as ""; readers take null as "no record".
        read: async (key) => (await host.readString(key)) || null,
        write: (key, value) => host.writeString(key, value),
        clear: (key) => host.clear(key),
      };
    } else {
      recordStorage = {
        read: async (key) => localStorage.getItem(key),
        write: async (key, value) => localStorage.setItem(key, value),
        clear: async (key) => localStorage.removeItem(key),
      };
    }
    return recordStorage;
  }

  // Serialized per storage key; a ref maps to its key through `requestKey`.
  const mutateStoredRecord = createSerialRecordMutator<string, ActiveFlowRecord>({
    async read(key) {
      const raw = await (await flowRecordStorage()).read(key);
      return raw === null ? null : (JSON.parse(raw) as ActiveFlowRecord);
    },
    async write(key, record) {
      await (await flowRecordStorage()).write(key, JSON.stringify(record));
    },
    async clear(key) {
      await (await flowRecordStorage()).clear(key);
    },
  });
  const mutateRecord = (ref: RequestRef, update: Parameters<typeof mutateStoredRecord>[1]) =>
    mutateStoredRecord(requestKey(ref), update);

  /** The record's progress, upgraded through the provider its source projects with. */
  function resolvedProgress(record: ActiveFlowRecord): FundingProgressSnapshot {
    return resolveFundingProgressSnapshot(
      record.progress,
      progressProviderForSource(record.sourceId).createProfile(),
      { fundedAt: record.funded, settledAt: record.settledAt },
    );
  }

  /** The source the request on screen runs under: the live world's, or in the browser the one
   *  the chosen method implies. */
  function foregroundSourceId(): string | undefined {
    if (live.value) return live.value.sourceId;
    return method.value === "crypto" ? undefined : meldSourceIdFor(method.value);
  }

  function initialProgress(startedAt: number): FundingProgressSnapshot {
    const sourceId = foregroundSourceId();
    const provider = progressProviderForSource(sourceId);
    if (isMeldSourceId(sourceId)) {
      // A card confirms within minutes; a bank transfer takes business days.
      const bank = method.value === "bank";
      const profile = provider.createProfile({
        ingressDurationMs: bank ? 24 * 60 * 60_000 : 5 * 60_000,
      });
      const estimatedDurationMs =
        profile.expectedUserDelayMs +
        profile.stages.reduce((total, stage) => total + stage.nominalMs, 0);
      return createFundingProgressSnapshot(profile, {
        preDetectionEstimateText: bank
          ? "1-2 business days after you pay"
          : "≈ minutes after you pay",
        estimatedCompletionAt: startedAt + estimatedDurationMs,
      });
    }
    const quotedEtaSeconds =
      sourcePrice.value?.kind === "price" ? sourcePrice.value.price.etaSeconds : undefined;
    const etaSeconds =
      quotedEtaSeconds !== undefined && Number.isFinite(quotedEtaSeconds) && quotedEtaSeconds > 0
        ? quotedEtaSeconds
        : undefined;
    const profile = provider.createProfile({
      ...(etaSeconds === undefined ? {} : { ingressDurationMs: etaSeconds * 1_000 }),
    });
    const estimatedDurationMs =
      profile.expectedUserDelayMs +
      profile.stages.reduce((total, stage) => total + stage.nominalMs, 0);
    return createFundingProgressSnapshot(profile, {
      preDetectionEstimateText:
        etaSeconds === undefined
          ? "≈10 min after your transfer"
          : `≈${Math.max(1, Math.round(etaSeconds / 60))} min after your transfer`,
      estimatedCompletionAt: startedAt + estimatedDurationMs,
    });
  }

  /** Keep the reason a request failed on its record, where it survives a restart. */
  function recordFailureReason(
    ref: RequestRef | undefined,
    reason: string,
    refunded = false,
  ): void {
    if (ref === undefined) return;
    void mutateRecord(ref, (record) =>
      !record || (record.failureReason === reason && (record.refunded ?? false) === refunded)
        ? undefined
        : { ...record, failureReason: reason, ...(refunded ? { refunded } : {}) },
    ).catch(() => {});
  }

  function advanceForegroundProgress(
    ref: RequestRef | undefined,
    signal: FundingProgressSignal,
    at: number,
  ): void {
    const current = foregroundProgress.value;
    if (!current || !sameOptionalRef(current.ref, ref)) return;
    const snapshot = advanceFundingProgressSnapshot(current.snapshot, { ...signal, at });
    if (snapshot !== current.snapshot) foregroundProgress.value = { ...current, snapshot };
  }

  function recordFundingProgress(
    ref: RequestRef,
    signal: FundingProgressSignal,
    at = Date.now(),
    markFunded = false,
  ): void {
    advanceForegroundProgress(ref, signal, at);
    void mutateRecord(ref, (record) => {
      if (!record) return undefined;
      const current = resolvedProgress(record);
      const progress = advanceFundingProgressSnapshot(current, { ...signal, at });
      const fundedAt = markFunded && record.funded === undefined ? at : record.funded;
      if (progress === current && fundedAt === record.funded) return undefined;
      return {
        ...record,
        tradeN: record.tradeN ?? ref.tradeN,
        ...(fundedAt === undefined ? {} : { funded: fundedAt }),
        progress,
      } satisfies ActiveFlowRecord;
    })
      .then((record) => {
        if (!record) return;
        const index = requestList.value.findIndex((item) => {
          const itemRef = recordRef(item);
          return itemRef !== null && sameRequestRef(itemRef, ref);
        });
        if (index < 0) return;
        const records = [...requestList.value];
        records[index] = {
          ...record,
          tradeN: record.tradeN ?? ref.tradeN,
          progress: resolvedProgress(record),
        };
        requestList.value = records;
      })
      .catch((e: unknown) => {
        console.warn(
          `[coinage] could not record progress for request #${ref.tradeN}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  function recordSharedFundingStep(ref: RequestRef, step: FundingStep): void {
    recordFundingProgress(
      ref,
      fundingProgressSignalForSharedStep(step),
      Date.now(),
      step !== "await-native",
    );
  }

  // Deposit window (foreground). Core stamps `deposit.expiresAt` on every rail (0 = none). When
  // it passes with no deposit seen, the top-up fails with the expiry reason.
  let depositExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  function clearDepositExpiry() {
    if (depositExpiryTimer !== null) clearTimeout(depositExpiryTimer);
    depositExpiryTimer = null;
  }
  function expireDeposit(ref: RequestRef | undefined) {
    depositExpiryTimer = null;
    if (fundsSeen.value) return; // a deposit landed in time: the window no longer matters
    fundingError.value = DEPOSIT_EXPIRED_REASON;
    const signal: FundingProgressSignal = { observation: { kind: "failed" } };
    if (ref === undefined) {
      advanceForegroundProgress(ref, signal, Date.now()); // mock world: nothing to persist
      return;
    }
    setStatus(ref, { kind: "failed", reason: DEPOSIT_EXPIRED_REASON });
    recordFundingProgress(ref, signal);
    recordFailureReason(ref, DEPOSIT_EXPIRED_REASON);
  }
  function armDepositExpiry(state: PaymentState, ref: RequestRef | undefined) {
    clearDepositExpiry();
    if (state.phase !== "awaiting-deposit" || fundsSeen.value) return;
    const at = state.deposit.expiresAt ?? 0;
    if (at <= 0) return;
    const delay = at - Date.now();
    if (delay <= 0) {
      expireDeposit(ref); // re-opened after the window closed: fail it on arrival
      return;
    }
    depositExpiryTimer = setTimeout(() => expireDeposit(ref), Math.min(delay, 2_147_483_647));
  }

  function observePaymentState(state: PaymentState, ref: RequestRef | undefined): void {
    lastState.value = state;
    armDepositExpiry(state, ref);
    const provider = progressProviderForSource(state.sourceId ?? ref?.sourceId);
    if (ref !== undefined && state.phase === "failed" && refundedFailure(state.failure.kind)) {
      setStatus(ref, { kind: "failed", reason: state.failure.message, refunded: true });
      recordFailureReason(ref, state.failure.message, true);
    }
    const signal = fundingProgressSignalForPaymentState(provider, state);
    if (!signal) return;
    if (signal.observation.kind === "settled") {
      const settledAt = Date.now();
      advanceForegroundProgress(ref, signal, settledAt);
      if (ref !== undefined) markSettled(ref, claimedBase.value, settledAt);
      return;
    }
    if (ref === undefined) {
      advanceForegroundProgress(ref, signal, Date.now());
      return;
    }
    recordFundingProgress(ref, signal);
  }

  /** Which requests are open, newest first. */
  async function readRequestIndex(): Promise<RequestRef[]> {
    try {
      return parseRequestIndex(await (await flowRecordStorage()).read(REQUEST_INDEX_KEY));
    } catch {
      return [];
    }
  }

  /**
   * Every change to the index goes through here, one at a time: read inside the lock, apply, write.
   */
  let indexLock: Promise<unknown> = Promise.resolve();
  function mutateRequestIndex(change: (current: RequestRef[]) => RequestRef[]): Promise<void> {
    const run = async () => {
      const storage = await flowRecordStorage();
      const current = parseRequestIndex(await storage.read(REQUEST_INDEX_KEY));
      await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex(change(current)));
    };
    // A failed change must not wedge the chain: the next one runs regardless.
    const next = indexLock.then(run, run);
    indexLock = next.catch(() => {});
    return next;
  }

  function sourceDisplayForRecord(): { sourceAmount: string; sourceSymbol: string } | null {
    const sourceSymbol = lastQuoteParams?.asset ?? quoted.value?.sourceAsset;
    if (!sourceSymbol) return null;
    const priced = sourcePrice.value;
    if (priced?.kind === "price") {
      return { sourceAmount: priced.price.formatted, sourceSymbol };
    }
    if (priced?.kind === "minimum") {
      return {
        sourceAmount: `≈ ${priced.minimum.neededFormatted}`,
        sourceSymbol: priced.minimum.assetSymbol,
      };
    }
    const state = lastState.value;
    const deposit = state && "deposit" in state ? state.deposit : null;
    if (live.value && deposit) {
      const estimate = estimateSourceAmount(deposit.amount, sourceSymbol);
      if (estimate) return { sourceAmount: `≈ ${estimate}`, sourceSymbol };
    }
    if (!live.value && amountBase.value !== null) {
      const estimate = estimateSourceFromCash(amountBase.value, sourceSymbol);
      if (estimate) return { sourceAmount: `≈ ${estimate}`, sourceSymbol };
    }
    const quote = quoted.value;
    return quote?.send && quote.symbol === sourceSymbol
      ? { sourceAmount: quote.send, sourceSymbol }
      : null;
  }

  async function persistActiveFlow(startedAt: number) {
    if (!lastQuoteParams) return;
    const world = live.value;
    if (!world) return; // mock world: nothing to re-open
    const tradeN = world.tradeN;
    const ref = foregroundRef ?? requestRefOf(world.sourceId, tradeN);
    try {
      const state = lastState.value;
      const current = foregroundProgress.value;
      const progress =
        current?.ref !== undefined &&
        sameRequestRef(current.ref, ref) &&
        current.startedAt === startedAt
          ? current.snapshot
          : initialProgress(startedAt);
      // What the buyer pays: the fiat quote for a Meld request, the source-coin figure otherwise.
      const sourceDisplay = isMeldSourceId(world.sourceId)
        ? quoted.value
          ? {
              sourceAmount: quoted.value.send,
              sourceSymbol: quoted.value.symbol,
              ...(quoted.value.fee != null ? { sourceFee: quoted.value.fee } : {}),
              ...(quoted.value.networkFee != null
                ? { sourceNetworkFee: quoted.value.networkFee }
                : {}),
            }
          : null
        : sourceDisplayForRecord();
      // The deposit window's deadline; the list and the reconcile judge expiry from the record.
      const depositExpiresAt =
        state?.phase === "awaiting-deposit" ? (state.deposit.expiresAt ?? 0) : 0;
      const record: ActiveFlowRecord = {
        amountHuman: amountHuman.value,
        chain: lastQuoteParams.chain,
        asset: lastQuoteParams.asset,
        ...(sourceDisplay ?? {}),
        startedAt,
        ...(state && "deposit" in state && state.deposit
          ? { depositAddress: state.deposit.address }
          : {}),
        progress,
        tradeN,
        // The session's source id; a resume re-enters under it.
        sourceId: world.sourceId,
        // Only a Meld request has these; the crypto rail leaves them null.
        ...(meldFundingRequestId ? { meldFundingRequestId } : {}),
        ...(isMeldSourceId(world.sourceId) && meldRegionCountry
          ? { meldCountry: meldRegionCountry }
          : {}),
        ...(depositExpiresAt > 0 ? { depositExpiresAt } : {}),
      };
      await mutateRecord(ref, () => record);
      await mutateRequestIndex((current) => [...current, ref]);
    } catch (e) {
      console.warn(
        `[coinage] request record write failed (it will not be re-openable): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Cancel tombstones the record; the sweep deletes it later. Awaited: the tombstone is durable
   *  before the world comes down. */
  async function tombstoneActiveFlow(
    ref: RequestRef,
    depositExpiresAt: number,
    sourceId: string,
  ): Promise<void> {
    const storage = await flowRecordStorage();
    const raw = await storage.read(requestKey(ref));
    if (raw === null) return;
    const record = JSON.parse(raw) as ActiveFlowRecord;
    await storage.write(
      requestKey(ref),
      JSON.stringify({
        ...record,
        cancelledAt: Date.now(),
        sourceId,
        ...(depositExpiresAt > 0 ? { depositExpiresAt } : {}),
      } satisfies ActiveFlowRecord),
    );
    console.warn(`[coinage] request #${ref.tradeN} tombstoned (cancelled; deposit window watched)`);
    void cancelWorkerJob(workerSessionId(sourceId, ref.tradeN));
    void reconcileBackground(); // drops the row and stops any background driver
  }

  /** Tells the worker the request is gone. Best effort. */
  async function cancelWorkerJob(sessionId: string): Promise<void> {
    if (!isHosted()) return;
    try {
      const { getStorageWorkerManager } = await import("~~/lib/worker-rpc");
      await getStorageWorkerManager().call("cancelFunding", { sessionId });
    } catch (e) {
      console.warn(
        `[coinage] worker cancel for ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Single-flight for the sweep: overlapping reconciles must not probe the same records. */
  let sweepingTombstones = false;
  /** The tombstone sweep: one bounded burner read per cancelled record. Funds found: resurrect as
   *  a funded open request. Confirmed empty after window plus grace: delete. Unreadable: keep and
   *  retry next reconcile. */
  async function sweepTombstones(): Promise<void> {
    if (sweepingTombstones || !isHosted()) return;
    sweepingTombstones = true;
    try {
      const tombstoned = (await readAllRequests()).filter((r) => r.cancelledAt !== undefined);
      if (tombstoned.length === 0) return;
      // Burner labels are keyed on the session's source id stamped on the tombstone, never on
      // the display source.
      const { probeTradeBurner, DEFAULT_SOURCE_ID } = await import("~~/lib/coinage-live");
      for (const record of tombstoned) {
        const ref = recordRef(record);
        if (ref === null) continue;
        const tradeN = ref.tradeN;
        try {
          const { address, free } = await step(
            `tombstone probe #${tradeN}`,
            15_000,
            probeTradeBurner(record.sourceId ?? DEFAULT_SOURCE_ID, tradeN),
          );
          if (free > 0n) {
            const storage = await flowRecordStorage();
            const raw = await storage.read(requestKey(ref));
            if (raw === null) continue;
            const { cancelledAt: _gone, ...revived } = JSON.parse(raw) as ActiveFlowRecord;
            await storage.write(
              requestKey(ref),
              JSON.stringify({ ...revived, funded: revived.funded ?? Date.now() }),
            );
            console.warn(
              `[coinage] request #${tradeN} resurrected: ${free} planck on ${address} after the cancel`,
            );
            void reconcileBackground(); // the row returns as a funded request and gets driven
            continue;
          }
          const windowEnd =
            (record.depositExpiresAt ?? (record.cancelledAt ?? 0) + DEFAULT_DEPOSIT_WINDOW_MS) +
            TOMBSTONE_GRACE_MS;
          if (Date.now() > windowEnd) {
            const storage = await flowRecordStorage();
            await storage.clear(requestKey(ref)).catch(() => {});
            await mutateRequestIndex((current) =>
              current.filter((r) => !sameRequestRef(r, ref)),
            ).catch(() => {});
            console.warn(
              `[coinage] request #${tradeN} reaped: window closed, burner confirmed empty`,
            );
          }
        } catch (e) {
          console.warn(
            `[coinage] tombstone probe #${tradeN} failed (kept): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      sweepingTombstones = false;
    }
  }

  /** Forgets one request: it completed, or it was abandoned before it started. */
  function clearActiveFlow(ref: RequestRef | undefined = foregroundRef ?? undefined) {
    if (!ref) return;
    void (async () => {
      await mutateRecord(ref, () => null);
      await mutateRequestIndex((current) => current.filter((r) => !sameRequestRef(r, ref)));
      await reconcileBackground(); // the list and the statuses are rebuilt only there
    })().catch(() => {
      /* a record left behind costs a stale row, never funds */
    });
  }

  /** What this surface reads of a worker's stored job record. */
  type WorkerJob = {
    phase?: string;
    done?: boolean;
    failure?: string;
    lastError?: string;
    state?: { fundsSeenAt?: number | null };
    claim?: { phase?: string; amount?: string } | null;
  };

  /** Failures the worker cannot get past on its own; re-opening the request is the retry. Every
   *  other failure re-arms. */
  const HELD_BACK_FAILURES = new Set(["shortfall", "timeout"]);

  /** The amount a claim credited, or null when the worker recorded none. */
  function claimedOf(amount: bigint | string | undefined): bigint | null {
    const value = typeof amount === "bigint" ? amount : amount ? BigInt(amount) : 0n;
    return value === 0n ? null : value;
  }

  /** Every worker job, keyed by workerSessionId; {} when there are none. */
  async function readWorkerJobs(): Promise<Record<string, WorkerJob>> {
    try {
      const raw = await (await flowRecordStorage()).read(WORKER_JOBS_KEY);
      return raw === null ? {} : (JSON.parse(raw) as Record<string, WorkerJob>);
    } catch {
      return {};
    }
  }

  /** The funding step a job has reached, or null when it has not seen funds. A finished funding
   *  leg is `done`. */
  function stepOfJob(job: WorkerJob | undefined): FundingStep | null {
    if (job?.done) return "done";
    if (typeof job?.state?.fundsSeenAt !== "number") return null;
    const phase = job.phase;
    return phase === "swap" || phase === "await-arrival" ? phase : "swap";
  }

  /** The funding step the worker's job has reached for this request, or null when it has no job
   *  or has not seen funds. */
  async function workerFundingStep(ref: RequestRef): Promise<FundingStep | null> {
    const jobs = await readWorkerJobs();
    // The same key builder the hand-off used.
    return stepOfJob(jobs[workerSessionId(ref.sourceId, ref.tradeN)]);
  }

  /**
   * Brings the open records up to date with the worker's jobs: a claimed job marks its request
   * settled (returned, and not driven), and a job past the deposit records the step it reached.
   * Idempotent.
   */
  async function settleFromWorkerJobs(
    records: ActiveFlowRecord[],
  ): Promise<{ claimed: Set<string>; heldBack: Set<string> }> {
    const claimed = new Set<string>();
    const heldBack = new Set<string>();
    const jobs = await readWorkerJobs();
    for (const record of records) {
      const ref = recordRef(record);
      if (ref === null || record.settledAt !== undefined) continue;
      const job = jobs[workerSessionId(ref.sourceId, ref.tradeN)];
      if (!job) continue;
      if (job.claim?.phase === "claimed") {
        markSettled(ref, claimedOf(job.claim.amount));
        claimed.add(requestRefKey(ref));
        continue;
      }
      if (job.phase === "failed") {
        recordWorkerFailure(ref, record, job);
        if (HELD_BACK_FAILURES.has(job.failure ?? "")) heldBack.add(requestRefKey(ref));
        continue;
      }
      const step = stepOfJob(job);
      if (step !== null) recordSharedFundingStep(ref, step);
    }
    return { claimed, heldBack };
  }

  /**
   * Records a job the worker gave up on: the reason, and the deposit's arrival if the worker saw
   * it.
   */
  function recordWorkerFailure(ref: RequestRef, record: ActiveFlowRecord, job: WorkerJob): void {
    const reason = job.lastError ?? "funding failed in the background";
    setStatus(ref, { kind: "failed", reason });
    if (resolvedProgress(record).failedAt !== undefined) return;
    recordFundingProgress(
      ref,
      { observation: { kind: "failed" } },
      Date.now(),
      stepOfJob(job) !== null,
    );
    recordFailureReason(ref, reason);
  }

  /** Requests whose finish is being or has been recorded this session. A failed write is removed;
   *  the next update retries. */
  const settling = new Set<string>();
  /** A claim landed: the request becomes history, with the amount the claim swept. */
  function markSettled(
    ref: RequestRef | undefined = foregroundRef ?? undefined,
    claimed = claimedBase.value,
    settledAt = Date.now(),
  ) {
    if (ref === undefined) return;
    const key = requestRefKey(ref); // per (sourceId, tradeN): two rails' #1 must not share a slot
    if (settling.has(key)) return;
    settling.add(key);
    advanceForegroundProgress(ref, { observation: { kind: "settled" } }, settledAt);
    void (async () => {
      await mutateRecord(ref, (record) => {
        if (!record) return undefined;
        const progress = advanceFundingProgressSnapshot(resolvedProgress(record), {
          observation: { kind: "settled" },
          at: settledAt,
        });
        return {
          ...record,
          settledAt,
          ...(claimed === null ? {} : { claimed: claimed.toString() }),
          progress,
        } satisfies ActiveFlowRecord;
      });
      await reconcileBackground(); // refreshes the list and prunes old history
    })().catch((e: unknown) => {
      settling.delete(key);
      console.warn("[coinage] could not record the finished purchase:", e);
    });
  }

  /** Every open request's record, newest first. Unreadable or malformed records are pruned from
   *  the index. */
  async function readAllRequests(): Promise<ActiveFlowRecord[]> {
    const index = await readRequestIndex();
    if (index.length === 0) return [];
    const storage = await flowRecordStorage();
    const out: ActiveFlowRecord[] = [];
    const alive: RequestRef[] = [];
    for (const ref of index) {
      const record = await storage
        .read(requestKey(ref))
        .then((raw) => (raw === null ? null : (JSON.parse(raw) as ActiveFlowRecord)))
        .catch(() => null);
      if (!record?.amountHuman || toCashBase(record.amountHuman) === null) continue;
      // The index entry is the identity; its source id is copied onto the record.
      const { sourceId: _stamped, ...rest } = record;
      const normalized: ActiveFlowRecord = {
        ...rest,
        tradeN: record.tradeN ?? ref.tradeN,
        ...(ref.sourceId === undefined ? {} : { sourceId: ref.sourceId }),
      };
      out.push({ ...normalized, progress: resolvedProgress(normalized) });
      alive.push(ref);
    }
    if (alive.length !== index.length) {
      // Drop only the entries found dead, against whatever the index holds now.
      const dead = index.filter((ref) => !alive.some((a) => sameRequestRef(a, ref)));
      await mutateRequestIndex((current) =>
        current.filter((r) => !dead.some((d) => sameRequestRef(d, r))),
      ).catch(() => {});
    }
    // Newest first; the trade number breaks ties.
    out.sort((a, b) => b.startedAt - a.startedAt || (b.tradeN ?? 0) - (a.tradeN ?? 0));
    return out;
  }

  /** The records the app acts on. Tombstoned requests are excluded; only the sweep reads them. */
  async function openRequests(): Promise<ActiveFlowRecord[]> {
    return (await readAllRequests()).filter((record) => record.cancelledAt === undefined);
  }

  /** Keeps the history bounded. Only settled records are dropped, oldest first. */
  async function pruneHistory(records: ActiveFlowRecord[]): Promise<ActiveFlowRecord[]> {
    const settled = records
      .filter((record) => record.settledAt !== undefined)
      .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
    const drop = settled.slice(HISTORY_LIMIT).flatMap((record) => {
      const ref = recordRef(record);
      return ref === null ? [] : [ref];
    });
    if (drop.length === 0) return records;
    await Promise.all(drop.map((ref) => mutateRecord(ref, () => null).catch(() => null)));
    await mutateRequestIndex((current) =>
      current.filter((r) => !drop.some((d) => sameRequestRef(d, r))),
    ).catch(() => {});
    return records.filter((record) => {
      const ref = recordRef(record);
      return ref === null || !drop.some((d) => sameRequestRef(d, ref));
    });
  }
  /** Boot: gets every open request converting again and puts nothing on screen. */
  async function resumeOpenRequests(): Promise<void> {
    if (!isHosted()) return; // mock flows persist nothing; there is nothing to pick up
    // reconcileBackground applies the worker's jobs; a purchase claimed off screen reaches history.
    await reconcileBackground();
  }

  /** Brings an off-screen request to the front: builds its world and resumes its session. */
  async function openRequest(ref: RequestRef): Promise<boolean> {
    const record = (await openRequests()).find((r) => {
      const candidate = recordRef(r);
      return candidate !== null && sameRequestRef(candidate, ref);
    });
    if (!record) return false;
    return enterRequest(record); // stops its background driver as it claims it
  }

  async function enterRequest(record: ActiveFlowRecord): Promise<boolean> {
    // Claim it before teardownWorld, whose reconcile would otherwise drive it off screen.
    const ref = recordRef(record);
    adopting = ref;
    if (ref !== null) stopBackground(ref);
    resuming.value = true;
    setAmount(record.amountHuman);
    // Restore the pay method from the persisted source id.
    method.value =
      record.sourceId === "meld-card"
        ? "card"
        : record.sourceId === "meld-bank"
          ? "bank"
          : "crypto";
    if (isMeldSourceId(record.sourceId)) meldCountry.value = record.meldCountry ?? null;
    lastQuoteParams = { chain: record.chain, asset: record.asset };
    try {
      teardownWorld();
      foregroundRef = ref; // after teardown, which clears it
      foregroundProgress.value = {
        ...(ref === null ? {} : { ref }),
        startedAt: record.startedAt,
        snapshot: resolvedProgress(record),
      };
      // The one timestamp the record knows.
      milestones.value = { 1: record.startedAt };
      // Two witnesses that a deposit arrived: the record and the worker's job. Either is enough.
      // A worker-only sighting is recorded through the progress path.
      const workerStep =
        ref === null || record.funded !== undefined ? null : await workerFundingStep(ref);
      if (ref !== null && workerStep !== null) recordSharedFundingStep(ref, workerStep);
      fundsSeen.value = record.funded !== undefined || workerStep !== null;
      // A buyer who finished the widget resumes onto the conversion screen.
      meldSubmitted.value = record.meldSubmittedAt !== undefined;
      console.warn(
        `[coinage] reopen request #${record.tradeN}: funded=${record.funded ?? "no"} worker=${workerStep ?? "no"} submitted=${record.meldSubmittedAt !== undefined}`,
      );
      // Core restores this request at `awaiting-deposit` whatever it is doing. Seed the step from
      // what a driver observed, or from the record's `funded` flag.
      if (ref !== null) {
        fundingStep.value =
          stepOf(requestStatus.value[requestRefKey(ref)]) ??
          workerStep ??
          (fundsSeen.value ? "swap" : null);
      }
      const epoch = quoteEpoch;
      // Re-enter under the record's own trade and source id.
      const world = await createLiveWorld(
        epoch,
        record.tradeN,
        undefined,
        record.sourceId as SourceId | undefined,
      );
      if (!world) return false;
      if (world.session.peek() === null) {
        // A record with no slot: forget this record and fall back to a fresh entry.
        world.dispose();
        clearActiveFlow(ref ?? undefined);
        reset();
        return false;
      }
      live.value = world;
      // Display context for the journey; no re-quote on this path.
      quoted.value = {
        send: record.sourceAmount ?? "",
        symbol: record.sourceSymbol ?? record.asset,
        fee: record.sourceFee ?? null,
        networkFee: record.sourceNetworkFee ?? null,
        nativeAmount: null,
        sourceAsset: record.asset,
        sourceChain: record.chain,
      };
      sub?.unsubscribe();
      sub = world.session.subscribe((state) => {
        observePaymentState(state, ref ?? undefined);
        // Drop the resume spinner on the first state, before re-entry raises the host's Claim
        // sheet.
        resuming.value = false;
      });
      // No time bound: resuming a claim in flight blocks on the host's Claim sheet.
      await world.session.resume();
      // Meld rail: rebuild a status-only client from the persisted funding-request id and resume
      // the poll.
      if (record.meldFundingRequestId) {
        const meldBaseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
        if (!meldBaseUrl) {
          // This build has no adapter to ask; say which request is going unwatched.
          console.warn(
            `[meld] request #${String(record.tradeN)} persisted funding id ${record.meldFundingRequestId}, but VITE_MELD_BASE_URL is unset; its payment status cannot be resumed`,
          );
        } else {
          const client = createMeldClient({
            baseUrl: meldBaseUrl,
            productId:
              (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
          });
          meldStatusClient = client;
          meldFundingRequestId = record.meldFundingRequestId;
          // Recover the pay URL from the adapter; the rail keeps pay URLs only in memory.
          void client
            .getStatus(record.meldFundingRequestId)
            .then((s) => {
              if (s.serviceProviderWidgetUrl)
                meldResumeWidgetUrl.value = s.serviceProviderWidgetUrl;
            })
            .catch(() => {});
          pollMeldStatus();
        }
      }
      const phase = world.session.getState().phase;
      // An expired, unfunded request gets no driver here either.
      const expired = phase === "awaiting-deposit" && isExpiredRecord(record, Date.now());
      if (!expired && (phase === "awaiting-deposit" || phase === "swapping")) driveFunding();
      // This request now owns the screen, so it must not also be driven off it.
      void reconcileBackground();
      return true;
    } catch (e) {
      // The record survives a failed resume.
      console.warn("[coinage] resume failed, falling back to a fresh start:", e);
      reset();
      return false;
    } finally {
      adopting = null;
      resuming.value = false;
    }
  }

  // Demo faucet
  async function fundFaucet(): Promise<void> {
    const s = lastState.value;
    // "sent" blocks too: a resolved faucet transfer is in a block. A failed transfer resets to
    // "idle".
    if (
      !live.value ||
      !s ||
      s.phase !== "awaiting-deposit" ||
      faucetState.value === "funding" ||
      faucetState.value === "sent"
    )
      return;
    faucetState.value = "funding";
    try {
      const tradeN = live.value.tradeN;
      const faucetRef = requestRefOf(live.value.sourceId, tradeN);
      await fundFromFaucet({ address: s.deposit.address, amount: s.deposit.amount });
      faucetState.value = "sent";
      // The transfer is in a block; the deposit exists on the burner. Latch and persist it through
      // the progress path.
      fundsSeen.value = true;
      recordSharedFundingStep(faucetRef, "swap");
      // The journey's received/processed beats complete now; this rail has no swap leg to report.
      if (fundingStep.value === null || fundingStep.value === "await-native") {
        fundingStep.value = "swap";
      }
      setStatus(faucetRef, { kind: "converting", step: "swap" });
      driveFunding(); // joins the running leg, or restarts one that had failed
    } catch (e: unknown) {
      faucetState.value = "idle";
      fundingError.value = e instanceof Error ? e.message : String(e);
    }
  }

  // Mock world controls (browser demo)
  function simulateDeposit() {
    if (mock.value && amountBase.value !== null)
      mock.value.harness.setSettlementBalance(amountBase.value);
  }

  /** The buyer finished in the widget: swaps the widget for the pay screen's loader while the poll
   *  confirms the status. */
  async function markMeldSubmitted(): Promise<void> {
    if (meldSubmitted.value) return;
    meldSubmitted.value = true;
    // Hand over to the journey now, not on `transaction_seen`, which can precede a 3DS/OTP
    // challenge that still needs the iframe. A terminal stage is left as-is.
    if (meldStage.value !== "complete" && meldStage.value !== "failed")
      meldStage.value = "receiving";
    meldHandedOff.value = true;
    // Persisted before returning; a re-open reads this stamp to keep the paid widget hidden.
    if (foregroundRef !== null)
      await mutateRecord(foregroundRef, (record) =>
        record ? { ...record, meldSubmittedAt: Date.now() } : undefined,
      );
  }

  /** Credits the settled Meld payment into the coinage leg, once. A no-op in the host world. */
  function creditMeldSettlement() {
    if (meldCredited) return;
    meldCredited = true;
    simulateDeposit();
  }

  function stopMeldPoll() {
    meldPollStop?.();
    meldPollStop = null;
  }

  /** The Meld payment's stage as progress on the request on screen. `receiving` once the widget
   *  was left; `complete` ends the rail's leg; `failed` fails the top-up with the provider's
   *  reason. Idempotent per stage. */
  function recordMeldStage(): void {
    const ref = foregroundRef ?? undefined;
    const record = (signal: FundingProgressSignal) =>
      ref === undefined
        ? advanceForegroundProgress(ref, signal, Date.now())
        : recordFundingProgress(ref, signal);
    switch (meldStage.value) {
      case "receiving":
        record({
          observation: { kind: "stage", stageKey: MELD_PAYMENT_STAGE },
          routeStatus: "receiving",
        });
        return;
      case "complete":
        record({ observation: { kind: "route-complete" }, routeStatus: "complete" });
        return;
      case "failed": {
        const reason = meldFailureMessage.value ?? "The payment could not be completed.";
        fundingError.value = reason;
        record({ observation: { kind: "failed" } });
        if (ref !== undefined) {
          setStatus(ref, { kind: "failed", reason });
          recordFailureReason(ref, reason);
        }
        return;
      }
      default:
        return;
    }
  }

  /** The provider's hosted pay page for the request on screen, or null. */
  const meldPayUrl = computed<string | null>(() => {
    // Hidden once the buyer finished the widget.
    if (meldSubmitted.value) return null;
    const state = lastState.value;
    const fromRail = state?.phase === "awaiting-deposit" ? state.deposit.payUrl : undefined;
    return fromRail ?? meldResumeWidgetUrl.value;
  });

  /** Polls the Meld payment's status into `meldStage` until a terminal stage. Idempotent; a no-op
   *  until a session ref exists. */
  function pollMeldStatus(): void {
    if (meldPollStop || meldStage.value === "complete") return;
    const client = meldStatusClient;
    const ref = meldFundingRequestId;
    if (!client || !ref) return;
    meldStage.value = meldStage.value ?? "waiting";
    let stopped = false;
    let pollFailures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    meldPollStop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const { status: st, depositFailure, delayed } = await getMeldStatus(client, ref);
        meldDelayed.value = delayed === true;
        // Hold the iframe until the buyer finishes it or a terminal status lands.
        // `transaction_seen`
        // can precede a 3DS/OTP challenge; `receiving` shows only once the widget was left.
        meldStage.value =
          st === "complete"
            ? "complete"
            : st === "failed"
              ? "failed"
              : meldSubmitted.value
                ? "receiving"
                : "waiting";
        if (meldStage.value === "receiving" || meldStage.value === "complete")
          meldHandedOff.value = true;
        if (meldStage.value === "complete") creditMeldSettlement();
        // Carry the adapter's own reason.
        if (meldStage.value === "failed")
          meldFailureMessage.value =
            depositFailure?.reason?.message ?? "The payment could not be completed.";
        recordMeldStage();
        pollFailures = 0;
      } catch (e) {
        // The delay marker is a live claim about the provider's retry; a poll that cannot confirm
        // it must not keep asserting it through an outage.
        meldDelayed.value = false;
        const httpStatus = (e as { status?: number } | null)?.status;
        // A 404 never self-heals: stop. A 401 is an auth problem on this side and retries below
        // with the other transients.
        if (httpStatus === 404) {
          console.error(`[meld] status poll got a terminal 404 for ${ref}, stopping:`, e);
          // This message, not the adapter's generic retry line.
          meldFailureMessage.value =
            "We can no longer find this payment. Do not pay again. Contact support with your reference.";
          meldStage.value = "failed";
          recordMeldStage();
          stopMeldPoll();
          return;
        }
        if (httpStatus === 401) {
          console.error(
            `[meld] status poll unauthorized for ${ref}; check VITE_MELD_PRODUCT_ID / adapter auth. Retrying; the payment is NOT being declared failed:`,
            e,
          );
        }
        pollFailures += 1;
        // Repeated failures are logged; the poll keeps retrying.
        if (pollFailures >= 5) {
          console.error(
            `[meld] status poll has failed ${String(pollFailures)} times for ${ref}:`,
            e,
          );
        } else {
          console.warn("[meld] status poll failed (will retry):", e);
        }
      }
      if (stopped) return;
      if (meldStage.value === "complete" || meldStage.value === "failed") {
        stopMeldPoll();
        return;
      }
      timer = setTimeout(() => void tick(), 3_000);
    };
    void tick();
  }
  function approveClaim() {
    mock.value?.handoff.confirmConsent();
  }
  function retry() {
    const s = session();
    if (!s) return;
    void s
      .retry()
      .then(() => console.info(`[coinage] retry() resolved, phase now ${s.getState().phase}`))
      .catch((e: unknown) => console.error("[coinage] retry() threw:", e));
  }

  /** Abandons the on-screen top-up. Core's cancel() clears the flow slot, the record leaves the
   *  list, and the world comes down. Funds are never touched. */
  async function cancelTopUp(): Promise<boolean> {
    // Declined, not failed: the request still stands.
    if (cancelling.value || claiming.value || resuming.value) return false;
    cancelling.value = true;
    try {
      // Last look before anything irreversible: funds on the burner mean a purchase in progress.
      // Refuse, latch it funded, and drive it. Fail open on a dead transport.
      if (live.value) {
        try {
          const held = await step(
            "pre-cancel balance check",
            8_000,
            live.value.readBurnerNativeOnAh(),
          );
          if (held > 0n) {
            console.warn(`[coinage] cancel refused: the burner already holds ${held} planck`);
            fundsSeen.value = true;
            // Latch the record as funded without moving its timeline.
            recordFundingProgress(
              foregroundRef ?? requestRefOf(live.value.sourceId, live.value.tradeN),
              { observation: { kind: "hold" } },
              Date.now(),
              true,
            );
            driveFunding();
            return false;
          }
        } catch (e) {
          console.warn(
            `[coinage] pre-cancel balance check failed (cancelling anyway): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const s = session();
      const ref = foregroundRef;
      const tradeN = ref?.tradeN;
      // Captured before cancel(): core's copy of the deposit expiry dies with the flow slot.
      const state = lastState.value;
      const depositExpiresAt =
        state?.phase === "awaiting-deposit" ? (state.deposit.expiresAt ?? 0) : 0;
      try {
        // While the world is still up: cancel() needs the session to clear its slot.
        if (s) await step("cancel top-up", 20_000, s.cancel());
      } catch (e) {
        // The slot clear is best effort; everything below still detaches the request.
        console.warn(
          `[coinage] cancel: core cancel failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (ref !== null && live.value) {
        try {
          await tombstoneActiveFlow(ref, depositExpiresAt, live.value.sourceId);
        } catch (e) {
          // An unwritable tombstone leaves the record active.
          console.warn(
            `[coinage] tombstone write failed (record left as-is): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      teardownWorld();
      console.warn(
        `[coinage] top-up cancelled${tradeN !== undefined ? ` (request #${tradeN})` : ""}`,
      );
      return true;
    } finally {
      cancelling.value = false;
    }
  }

  /** Loads the region dropdown from the adapter's live catalog. On failure `supportedCountries`
   *  stays null and the screen keeps its static list. */
  async function loadSupportedCountries(): Promise<void> {
    const rows = await fetchSupportedCountries();
    if (rows !== null) supportedCountries.value = rows;
  }

  return {
    // state
    lastState,
    phase,
    fundingStep,
    fundingError,
    fundingNotice,
    claimStage,
    claimedBase,
    foregroundProgress,
    amountHuman,
    amountBase,
    method,
    meldCountry,
    quoted,
    quoteError,
    meldMethodUnavailable,
    supportedCountries,
    meldCorridor,
    meldStage,
    meldDelayed,
    meldFailureMessage,
    meldResumeWidgetUrl,
    meldSubmitted,
    meldHandedOff,
    meldPayUrl,
    sourcePrice,
    loading,
    resuming,
    faucetState,
    fundsSeen,
    canSkipDeposit,
    cancelling,
    mock,
    live,
    refundAddress,
    revealRefundKey,
    // derived helpers
    isFaucetConfigured,
    amountStatus,
    // actions
    setAmount,
    setMethod,
    setMeldCountry,
    loadSupportedCountries,
    fetchQuote,
    fetchMeldQuote,
    start,
    reset,
    /** Drops and rebuilds the chain clients in place. */
    reconnectChains,
    resumeOpenRequests,
    openRequests,
    openRequest,
    requestList,
    requestStatus,
    claiming,
    journeyDone: journeyDoneCount,
    milestones,
    fundFaucet,
    simulateDeposit,
    pollMeldStatus,
    markMeldSubmitted,
    approveClaim,
    retry,
    cancelTopUp,
  };
});
