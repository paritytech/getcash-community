// Session store: the only writer of flow state; screens project it. Owns quote
// orchestration, the hand-off to the worker, claim progress, and recovery.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { TOKENS, type ChainflipRail, type PaymentState, type SourceId } from "@getsome/core";
import { egressFor, SOURCE_CONFIG_BY_ID, type ChainflipToken } from "@getsome/chainflip";
import type { RefundKey } from "@getsome/ephemeral";
import { PERMILL, recordedRoute, type ConversionRoute, type FundingStep } from "@getsome/funding";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  progressProviderForSource,
  type FundingProgressSnapshot,
} from "../funding/progress";
import { depositWindowFor } from "../funding/config";
import {
  effectiveSourceId,
  isTopUp,
  railProviderOf,
  routeOf,
  type TopUpRecord,
} from "../funding/requests/model";
import {
  createFakeMeldClient,
  createMeldClient,
  createMeldRail,
  pickBestQuote,
  type MeldClientLike,
  type MeldQuoteRaw,
} from "@getsome/meld";
import { CASH_DECIMALS } from "@getsome/people";
import { meldPaymentMethod, resolveMeldRegion } from "~~/lib/region";
import {
  fetchCorridor,
  fetchSupportedCorridors,
  fetchSupportedCountries,
  methodFor,
  type SupportedCorridor,
  type SupportedCountry,
} from "~~/lib/supported";
import { requestRefOf, type RequestRef } from "../utils/request-index";
import { journeyScaleOf, type JourneySteps } from "../funding/requests/views";
import { estimateSourceAmount, estimateSourceFromCash } from "~~/lib/demo-rates";
import { priceSourceLeg, type SourcePriceResult } from "~~/lib/source-price";
import {
  createMockCoinageSession,
  DEFAULT_SOURCE_ID,
  depositTokenOf,
  workerSessionId,
  type MockCoinageWorld,
} from "~~/lib/coinage";
import type { HostedCoinageWorld } from "~~/lib/coinage-live";
import { isHosted } from "~~/lib/host-account";
import type { FundingSizing, PoolFundingSizing, PsmFundingSizing } from "~~/lib/funding-fees";
import { isDemoBuild } from "../utils/demo";
import { isMeldSourceId, meldSourceIdFor } from "../funding/source-ids";
import { toCashBase } from "../utils/cash";
import { isMoneyAmount, sumMoney } from "../utils/money";
import { fundFromFaucet, isFaucetConfigured } from "~~/lib/faucet";
import { sourceIdFor } from "~~/lib/config";
import { useRequestsStore } from "./requests";

export { DEPOSIT_EXPIRED_REASON } from "../funding/requests/model";

/** Stand-in address for the mock world, which never touches a chain. */
const DEV_RECIPIENT = "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9";

/** Persisted per request; enough to re-open it. */
export interface ActiveFlowRecord {
  amountHuman: string;
  chain: string;
  asset: string;
  sourceAmount?: string;
  sourceSymbol?: string;
  /** The provider's quoted fee (Meld), in `sourceSymbol` units. */
  sourceFee?: string;
  /** The components of `sourceFee`, as the rail reported them. Persisted so a resumed request's
   *  breakdown reads the same as the one quoted at the start. */
  /** The provider that priced the request, for the journey's reference rows. */
  sourceProvider?: string;
  sourceTransactionFee?: string;
  sourceNetworkFee?: string;
  sourcePartnerFee?: string;
  /** The funding leg's own network fee as the quote priced it, in `sourceSymbol` units. */
  sourceChainFee?: string;
  /** The PSM's fee on the mint as the quote priced it, in `sourceSymbol` units; PSM tier only. */
  sourceMintFee?: string;
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
  /** Meld fiat requests only: the provider that took the payment (Transak, Koywe, ...). The
   *  concluded journey names it, and a refund is theirs to trace. */
  meldServiceProvider?: string;
  failureReason?: string;
  /** True when the failed swap was refunded to the request's own key. */
  refunded?: boolean;
  /** What actually came back, in the source asset's BASE units as the rail reports them (not a
   *  decimal string — `formatSourceAmount` renders it), and the chain transaction that returned
   *  it. Less than the deposit: the refund pays its own network fees. Both live on the request's
   *  `refund` progress, so without them a journey reopened from history can say only that a refund
   *  happened, not how much or where to look for it. */
  refundAmount?: string;
  refundTxRef?: string;
  /** Timestamp of the user's cancel. Marks a tombstone: hidden from every list, never driven,
   *  resurrected or deleted by the sweep. */
  cancelledAt?: number;
  /** The deposit channel's expiry, captured at cancel time. Bounds the tombstone's lifetime. */
  depositExpiresAt?: number;
  /** The session's source id, which keys the burner label. Absent on old records, meaning
   *  dot-assethub. */
  sourceId?: string;
}

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

export interface QuotedView {
  send: string;
  symbol: string;
  /** The total fee in `symbol` units, when the rail quotes one (Meld does). */
  fee?: string | null;
  /** The components of `fee`, each as the rail reported it. Meld sends these as separate fields,
   *  so they are carried through rather than derived from `fee`; any of them can be absent from a
   *  given quote, and the breakdown simply omits what it was not given. */
  transactionFee?: string | null;
  networkFee?: string | null;
  partnerFee?: string | null;
  /** The funding leg's own network fee, in `symbol` units: what the swap and the teleport up to
   *  CASH on People cost, which the rail's quote knows nothing about. Priced by the app, not
   *  reported by the rail. */
  chainFee?: string | null;
  /** The PSM's fee on the mint, in `symbol` units: the flat cut the PSM tier takes for turning the
   *  delivered stable into CASH. Priced by the app; null on the pool tier, whose costs have no
   *  such component. */
  mintFee?: string | null;
  /** The provider these terms came from ("TRANSAK"), not the aggregator in front of it. */
  provider?: string | null;
  /** Live world only: what the rail must deliver to the burner, in `depositToken`'s base units:
   *  the native on the pool tier, the PSM's external on the PSM tier. */
  nativeAmount: bigint | null;
  /** The token `nativeAmount` is counted in. Set with it; a quote without one is a pool one. */
  depositToken?: ChainflipToken;
  sourceAsset: string | null;
  sourceChain: string | null;
}

/**
 * The quote's own implied rate for the token Meld delivers: the fiat left after the rail's fees is
 * what bought `destinationAmount`. Null when the quote cannot price it.
 */
function meldImpliedRate(raw: MeldQuoteRaw): { delivered: number; fiatPerToken: number } | null {
  const delivered = Number(raw.destinationAmount);
  const netFiat = Number(raw.provider.sourceAmount) - Number(raw.provider.totalFee ?? 0);
  if (!Number.isFinite(delivered) || delivered <= 0) return null;
  if (!Number.isFinite(netFiat) || netFiat <= 0) return null;
  return { delivered, fiatPerToken: netFiat / delivered };
}

/** Carried unrounded: the row's display rounds it, and the total has to sum the exact figures. */
function feeFiat(total: number): string | null {
  return Number.isFinite(total) && total > 0 ? String(total) : null;
}

/**
 * The funding leg's network fee in the quote's fiat, or null when the quote cannot price it.
 *
 * Meld's own fees stop where its delivery does: the route's token on Asset Hub. Getting from
 * there to CASH on People costs more, all of it already sized by the funding estimate and already
 * inside what the buyer pays, because the deposit was over-bought to cover it. On the pool tier
 * that is `keepNativeForFees` (dispatch, execution and delivery on Asset Hub, in native) and
 * `remoteFeeBuffer` (execution on People, in CASH). On the PSM tier the Asset Hub side is all in
 * the delivered stable: the batch's dispatch fee plus what the mint keeps out for the XCM's
 * execution and delivery, the fee allowance and the asset's min_balance that keeps the burner
 * alive (local/psm/PLAN.md §4.2, M13). The min_balance and the unspent allowance stay on the
 * burner, but the buyer paid for them, so they are part of the cost shown. None has a row of its
 * own on the rail's quote, so the breakdown prices them here.
 *
 * The delivered token's side converts at the quote's implied rate (`meldImpliedRate`). The CASH
 * side takes the peg this app quotes against throughout, one CASH to one unit of the quote fiat
 * (see `sizeMeldNativeBudget`).
 */
function meldChainFeeFiat(raw: MeldQuoteRaw, sizing: FundingSizing): string | null {
  const rate = meldImpliedRate(raw);
  if (rate === null) return null;
  const inCash = (amount: bigint) => Number(amount) / 10 ** CASH_DECIMALS;
  const onAssetHub =
    sizing.tier === "pool"
      ? (Number(sizing.keepNativeForFees) / 10 ** TOKENS.PAS.decimals) * rate.fiatPerToken
      : (Number(sizing.dispatchExternal + sizing.heldBackExternal) /
          10 ** TOKENS[sizing.external].decimals) *
        rate.fiatPerToken;
  return feeFiat(onAssetHub + inCash(sizing.remoteFeeBuffer));
}

/**
 * The PSM's fee on the mint in the quote's fiat, or null when the quote cannot price it. The
 * pipeline mints everything the dispatch fee and the held-back external leave of what the
 * provider delivered, and the PSM takes its Permill of that; at the quote's implied rate, since
 * the fee is taken in the stable.
 */
function meldMintFeeFiat(raw: MeldQuoteRaw, sizing: PsmFundingSizing): string | null {
  const rate = meldImpliedRate(raw);
  if (rate === null) return null;
  const minted =
    rate.delivered -
    Number(sizing.dispatchExternal + sizing.heldBackExternal) /
      10 ** TOKENS[sizing.external].decimals;
  return feeFiat(minted * (sizing.feeRate / Number(PERMILL)) * rate.fiatPerToken);
}

/** Half a cent: below this the split and the total still round to the same figure. */
const FEE_SPLIT_TOLERANCE = 0.005;

/**
 * Reports a rail total its own components do not account for.
 *
 * The breakdown lists the components and totals the rail's `fee`, so the two disagreeing means the
 * screen shows a sum that does not sum. Nothing is corrected here: what the buyer is charged is
 * the rail's total, not ours, and a component the rail did not name is still money it took. The
 * disagreement is said out loud rather than buried in a figure that looks reconciled.
 */
function warnOnFeeSplitDrift(raw: MeldQuoteRaw): void {
  const { transactionFee, networkFee, partnerFee, totalFee } = raw.provider;
  const summed = sumMoney(transactionFee, networkFee, partnerFee);
  if (summed === null || !isMoneyAmount(totalFee)) return;
  if (Math.abs(summed - Number(totalFee)) < FEE_SPLIT_TOLERANCE) return;
  console.warn(
    `[meld] fee split does not add up: components sum to ${summed} against a reported total of ` +
      `${totalFee} ${raw.context.fiat}; the breakdown totals the reported figure`,
  );
}

/** The Meld quote as the views read it. The buyer pays fiat, so the native budget and source
 *  coin the crypto rail carries are not part of it. */
function meldQuotedView(raw: MeldQuoteRaw, sizing: FundingSizing): QuotedView {
  warnOnFeeSplitDrift(raw);
  return {
    send: raw.provider.sourceAmount,
    symbol: raw.context.fiat,
    fee: raw.provider.totalFee ?? null,
    provider: raw.provider.serviceProvider,
    transactionFee: raw.provider.transactionFee ?? null,
    networkFee: raw.provider.networkFee ?? null,
    partnerFee: raw.provider.partnerFee ?? null,
    chainFee: meldChainFeeFiat(raw, sizing),
    mintFee: sizing.tier === "psm" ? meldMintFeeFiat(raw, sizing) : null,
    nativeAmount: null,
    sourceAsset: null,
    sourceChain: null,
  };
}

export const useSessionStore = defineStore("session", () => {
  // Worlds and subscription (non-reactive internals)
  const mock = shallowRef<MockCoinageWorld | null>(null);
  const live = shallowRef<HostedCoinageWorld | null>(null);
  let sub: { unsubscribe(): void } | null = null;
  /** Every request's record; the list and the statuses are views over it. */
  const requests = useRequestsStore();

  // Reactive projection
  /** Core's last state for the request on screen, as it arrived. */
  const lastState = shallowRef<PaymentState | null>(null);
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
  /** Bulk per-country corridors for greying the dropdown; null until loaded or when unreachable. */
  const corridorByCountry = shallowRef<Map<string, SupportedCorridor> | null>(null);
  /** The selected country's corridor: its resolved fiat and the methods it routes. Null when
   *  discovery is unreachable. */
  const meldCorridor = shallowRef<SupportedCorridor | null>(null);
  /** The provider widget URL recovered when resuming a Meld request; null unless a resume found a
   *  live one. */
  const meldResumeWidgetUrl = ref<string | null>(null);
  /** Latched once the settled payment has been credited to the coinage leg. */
  let meldCredited = false;
  /** The swap network's price for the selected source; `pending` while asking. */
  const sourcePrice = shallowRef<SourcePriceResult | null>(null);
  const loading = ref(false);
  const resuming = ref(false);
  const faucetState = ref<"idle" | "funding" | "sent">("idle");
  /** True while cancelTopUp runs. */
  const cancelling = ref(false);
  /** Set when a cancel was refused because the payment is already on its way; shown to the buyer. */
  const cancelNotice = ref<string | null>(null);
  /** Asks the journey to open its refund-key panel unprompted; only the preview deck sets it. */
  const revealRefund = ref(false);

  // Monotonic guard for async quote work. Every fetchQuote and reset bumps it; a resolution
  // with a stale token disposes what it built.
  let quoteEpoch = 0;
  let lastQuoteParams: { chain: string; asset: string } | null = null;
  // The Meld status client, captured when a Meld session is created.
  let meldStatusClient: MeldClientLike | null = null;
  // The adapter's funding-request id, which its status route answers on.
  // The journey shows it as the payment's reference when a top-up fails, and reads it off the
  // request's own record: a top-up opened from the list has no session behind it.
  let meldFundingRequestId: string | null = null;
  /** Meld fiat requests only: the provider we opened the request with. The adapter's funding
   *  record does not report it back, so the create call is the only moment it can be captured;
   *  the request's record keeps it from there. */
  let meldServiceProvider: string | null = null;
  // The country the current Meld quote was priced in.
  let meldRegionCountry: string | null = null;
  /** The ref of the request on screen; set on start or re-open, cleared with the world. */
  let foregroundRef: RequestRef | null = null;

  function session() {
    return mock.value?.session ?? live.value?.session ?? null;
  }

  // Mock world: the settled payment lands on the coinage leg once, as the poll did directly.
  watch(
    () => requests.meldStage,
    (stage) => {
      if (stage === "complete") creditMeldSettlement();
    },
  );
  /** Whether the deposit can be skipped: one is still awaited, the faucet has not paid, and Skip
   *  was not already pressed for this request (persisted, so a re-open never offers it again). */
  const canSkipDeposit = computed(
    () =>
      requests.phase === "awaiting-deposit" &&
      !requests.fundsSeen &&
      !requests.depositSkipped &&
      faucetState.value === "idle",
  );
  /** The on-screen request has its live session, so a cancel can clear the slot it holds. */
  const cancelReady = computed(() => live.value !== null || mock.value !== null);
  /** Where a failed swap refunds the request on screen; null on the manual rail. */
  const refundAddress = computed(() => (mock.value ?? live.value)?.refundAddress ?? null);
  /** Reads the refund key from the world on demand. */
  function revealRefundKey(): RefundKey | null {
    return (mock.value ?? live.value)?.revealRefundKey() ?? null;
  }

  /**
   * The recovery key for a request that is not on screen, re-derived from its own identity.
   *
   * For a refund opened out of history, where there is no world to ask. The host derives the same
   * seed it did when the request was opened, so this is the key the rail was handed. Null off-host
   * — a dev build has no entropy root, and the deck's scenes install a mock world instead.
   */
  async function recoverRefundKeyFor(sourceId: string, tradeN: number): Promise<RefundKey | null> {
    if (!isHosted()) return null;
    try {
      const { probeRefundKey } = await import("~~/lib/coinage-live");
      // A record's source id is a plain string on disk, and nothing narrows it here because the
      // derivation fails closed on its own: an id with no refund chain, or one the source registry
      // does not know, comes back null rather than deriving against the wrong chain.
      return await probeRefundKey(sourceId as SourceId, tradeN);
    } catch (e) {
      console.warn("[coinage] refund key recovery failed:", e);
      return null;
    }
  }

  /** The trade number the next mock request takes: one past the highest this source has a record
   *  for, so a browser session's requests never share a key. */
  function nextMockTradeN(sourceId: string): number {
    let highest = 0;
    for (const { ref } of requests.records) {
      if (effectiveSourceId(ref) === sourceId) highest = Math.max(highest, ref.tradeN);
    }
    return highest + 1;
  }

  /** The journey's scale for the request on screen: the crypto timeline runs three steps, the
   *  card's five. The record on screen owns its route; the selected method stands in on the entry
   *  screens, before there is a record. */
  const journeySteps = computed<JourneySteps>(() =>
    journeyScaleOf(requests.foregroundRecord?.route ?? method.value),
  );

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

  /** Prices the selected source for this budget, in `depositToken`, in the background.
   *  Epoch-guarded. */
  function priceSelectedSource(
    chain: string,
    asset: string,
    targetBaseUnits: bigint,
    depositToken: ChainflipToken,
    epoch: number,
  ) {
    const sourceId = sourceIdFor(chain, asset);
    if (sourceId === undefined) return;
    sourcePrice.value = { kind: "pending" };
    const egress = egressFor(depositToken);
    void priceSourceLeg({ sourceId, targetBaseUnits, egress }).then((result) => {
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
    stopSimulatedPayment();
    meldResumeWidgetUrl.value = null;
    meldCredited = false;
    meldFundingRequestId = null;
    meldServiceProvider = null;
    meldStatusClient = null;
    cancelNotice.value = null;
    sub?.unsubscribe();
    sub = null;
    mock.value?.session.dispose();
    mock.value = null;
    live.value?.dispose(); // tears down the session (chain clients are shared, stay up)
    live.value = null;
    lastState.value = null;
    quoted.value = null;
    // Cleared with the epoch bump: a `pending` set by the outgoing quote is never resolved.
    sourcePrice.value = null;
    faucetState.value = "idle";
    revealRefund.value = false;
    foregroundRef = null;
    requests.leave();
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
    requests.setTransientError(null);
    requests.fundingNotice = null;
    // Warn level with message strings: a host logger may forward only warn and error.
    console.warn("[coinage] funding: handing off to the worker (fund the burner to begin)");
    void world
      .runFunding({
        onStep: (s) => {
          console.warn(`[coinage] funding step: ${s}`);
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
          markSettled(ref, amount);
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
        // The screen shows the failure now; the record waits for the worker's verdict.
        requests.setTransientError({ message: reason, at: Date.now(), source: "handoff" });
        recordDriverFailure(ref, reason);
      });
  }

  /** Brings the records up to date with the host, the worker's jobs, the chain and the provider;
   *  the store's reconcile hands the worker any open request it lost. */
  async function reconcileBackground(reason: "boot" | "refresh" = "refresh"): Promise<void> {
    if (!isHosted()) return;
    await requests.reconcile(reason);
  }

  /** The hosted world up to hydration, shared by the fresh-quote and resume paths. Returns null
   *  when a newer quote superseded this one. `staleFlowMs` is the request's deposit window, so
   *  core's stale guard and the record's deadline agree. `route` is the request's tier, already
   *  decided: the world freezes it and never decides one. */
  async function createLiveWorld(
    epoch: number,
    staleFlowMs: number,
    route: ConversionRoute,
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
        // A re-opened request's own number; a new one's is the free number the quote reserved.
        ...(tradeN === undefined ? {} : { tradeN }),
        staleFlowMs,
        route,
        // The fiat route injects a Meld rail and its source id; the crypto route leaves both unset.
        ...(rail ? { rail } : {}),
        ...(sourceId ? { sourceId } : {}),
        onClaimProgress: (stage, claimed) => {
          if (foregroundRef === null) return;
          void requests.observe(foregroundRef, {
            source: "core",
            at: Date.now(),
            claim: { stage, ...(claimed === undefined ? {} : { claimed: claimed.toString() }) },
          });
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

  /**
   * The conversion tier a fresh quote is built on, decided once here and handed down: the rail
   * is built for the asset the tier delivers, and the world freezes the tier into the hand-off.
   * Nothing downstream decides again. The mock world runs over fakes with no PSM to ask, so
   * outside the host the tier is the pool.
   */
  async function chooseQuoteRoute(amount: bigint): Promise<ConversionRoute> {
    if (!isHosted()) return { tier: "pool" };
    const { chooseHostedRoute } = await import("~~/lib/coinage-live");
    return step("route selection", 10_000, chooseHostedRoute(amount));
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
   * Builds the Meld rail for the current selection and the token the route delivers, or signals
   * that the method is not routed for the region.
   */
  async function buildMeldRail(route: ConversionRoute): Promise<
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
        meldServiceProvider = r.serviceProvider || null;
        return s;
      },
      getStatus: (id) => baseClient.getStatus(id),
      cancel: (id) => baseClient.cancel(id),
    };
    meldStatusClient = meldClient;
    const rail = createMeldRail({
      client: meldClient,
      country: region.country,
      fiat: region.fiat,
      method: meldMethod,
      paymentMethodType,
      token: depositTokenOf(route),
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
      // The rail's own destination code; the budget is priced in the asset the rail is built with.
      destinationCurrencyCode: TOKENS.PAS.meldCurrencyCode,
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
    return BigInt(Math.ceil(fiat * nativePerFiat * 10 ** TOKENS.PAS.decimals));
  }

  /**
   * The funding leg's sizing for a mock-world Meld quote: the destination's execution fee and the
   * native the burner keeps for the program, read live off the public chains.
   *
   * The hosted world gets these from the world that sized its deposit. Here there is no such
   * world yet, so the quote reads them itself — best effort, like the crypto route's pool
   * pricing. Outside a browser there is nothing to read and nothing to price: the zero sizing
   * leaves both the budget and the breakdown as they were.
   */
  async function meldFundingSizing(settleAmount: bigint): Promise<PoolFundingSizing> {
    if (typeof window === "undefined") {
      return { tier: "pool", remoteFeeBuffer: 0n, keepNativeForFees: 0n };
    }
    const { estimatePublicFundingSizing, FALLBACK_FUNDING_SIZING } =
      await import("~~/lib/funding-fees");
    return step(
      "funding sizing estimate (public read)",
      20_000,
      estimatePublicFundingSizing({ settleAmount, probeAddress: DEV_RECIPIENT }),
    ).catch(() => FALLBACK_FUNDING_SIZING);
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
      // The tier first: the rail is built for the asset the tier delivers.
      const route = await chooseQuoteRoute(amountBase.value);
      if (epoch !== quoteEpoch) return;
      const built = await buildMeldRail(route);
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
        // The funding leg's fees, from the same public reads the crypto route prices with. They
        // enlarge the budget the rail must deliver — the buyer pays for them — and the quote
        // reports them as their own row. Skipped in node test runs, which have no chain to read:
        // a zero sizing quotes exactly what this path quoted before it priced the leg at all.
        const sizing = await meldFundingSizing(amountBase.value);
        if (epoch !== quoteEpoch) return;
        // The Meld rail egresses the native token and is sized by a native budget: the settle
        // amount plus People's execution fee, quoted against the fiat peg, plus the native the
        // burner keeps for the program on Asset Hub.
        const quotedBudget = await sizeMeldNativeBudget(
          built.client,
          { ...built.region, paymentMethodType: built.paymentMethodType },
          amountBase.value + sizing.remoteFeeBuffer,
        );
        if (epoch !== quoteEpoch) return;
        if (quotedBudget === null) {
          quoteError.value = "No provider offers this payment method or region. Try another.";
          return;
        }
        const nativeBudget = quotedBudget + sizing.keepNativeForFees;
        const world = await createMockCoinageSession({
          recipient: DEV_RECIPIENT,
          amount: amountBase.value,
          sourceId: built.sourceId,
          rail: built.rail,
          nativeBudget,
          fundingSizing: sizing,
          tradeN: nextMockTradeN(built.sourceId),
          route,
        });
        await world.session.ready;
        const quote = await world.session.quote();
        if (epoch !== quoteEpoch) {
          world.session.dispose();
          return;
        }
        mock.value = world;
        quoted.value = meldQuotedView(quote.raw as MeldQuoteRaw, world.fundingSizing);
        return;
      }
      // Hosted world: the same rail over the real host seams. The provider delivers the route's
      // token to the burner and the funding leg converts it to CASH.
      const { nextHostedTradeNumber } = await import("~~/lib/coinage-live");
      const tradeN = await step(
        "trade number",
        10_000,
        nextHostedTradeNumber(built.sourceId, (n) => requests.hasTrace(built.sourceId, n)),
      );
      const world = await createLiveWorld(
        epoch,
        depositWindowFor(method.value),
        route,
        tradeN,
        built.rail,
        built.sourceId,
      );
      if (!world) return;
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
      quoted.value = meldQuotedView(quote.raw as MeldQuoteRaw, world.fundingSizing);
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
      const route = await chooseQuoteRoute(amountBase.value);
      if (epoch !== quoteEpoch) return;
      if (isHosted()) {
        const { nextHostedTradeNumber } = await import("~~/lib/coinage-live");
        const tradeN = await step(
          "trade number",
          10_000,
          nextHostedTradeNumber(DEFAULT_SOURCE_ID, (n) => requests.hasTrace(DEFAULT_SOURCE_ID, n)),
        );
        const world = await createLiveWorld(epoch, depositWindowFor("crypto"), route, tradeN);
        if (!world) return; // superseded by a newer quote
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
        const depositToken = depositTokenOf(route);
        quoted.value = {
          send: quote.source.formatted,
          symbol: quote.source.assetSymbol,
          nativeAmount: quote.source.amount,
          depositToken,
          sourceAsset: asset,
          sourceChain: chain,
        };
        priceSelectedSource(chain, asset, quote.source.amount, depositToken, epoch);
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
          tradeN: nextMockTradeN(sourceId),
          route,
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
              { sizeNativeBudget, PASEO_UNDERLYING_ASSET_ID },
              { estimatePublicFundingSizing, FALLBACK_FUNDING_SIZING },
            ] = await Promise.all([
              import("~~/lib/host-chain"),
              import("@getsome/funding"),
              import("~~/lib/funding-fees"),
            ]);
            const client = await connectChain(ASSET_HUB);
            // Size the deposit from live public reads. Best effort; falls back to the defaults,
            // and an unreachable People chain leaves the pool quote below untouched.
            const sizing = await step(
              "funding sizing estimate (public read)",
              20_000,
              estimatePublicFundingSizing({
                settleAmount: settleForPricing,
                probeAddress: DEV_RECIPIENT,
              }),
            ).catch(() => FALLBACK_FUNDING_SIZING);
            nativeAmount = await step(
              "pool quote (public read)",
              30_000,
              (async () =>
                sizeNativeBudget({
                  client,
                  underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
                  settleAmount: settleForPricing,
                  remoteFeeBuffer: sizing.remoteFeeBuffer,
                  keepNativeForFees: sizing.keepNativeForFees,
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
          depositToken: TOKENS.PAS,
          sourceAsset: est && cfg ? cfg.asset : null,
          sourceChain: chain,
        };
        // The swap network's quote endpoint is public; it needs the pool figure above as its
        // target.
        if (nativeAmount !== null) {
          priceSelectedSource(chain, asset, nativeAmount, TOKENS.PAS, epoch);
        }
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
    // The request's identity for every record write from here on.
    foregroundRef = requestRefOf(world.sourceId, world.tradeN);
    // On screen as soon as its record enters memory, before the host write completes.
    requests.setForeground(foregroundRef);
    const ref = foregroundRef;
    sub?.unsubscribe();
    sub = world.session.subscribe((state) => {
      observePaymentState(state, ref);
    });
    await world.session.start(refundAddress === null ? {} : { refundAddress });
    // The slot exists, so the number is taken for good: the next request derives a fresh burner.
    await world.advanceTrade();
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
    // The record survives: its burner may hold funds, and the worker keeps its job.
    void reconcileBackground();
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

  /** A funding step the worker reached, recorded as the worker's own sighting of the request. */
  function recordSharedFundingStep(ref: RequestRef, step: FundingStep): void {
    const at = Date.now();
    // `await-native` reports no deposit; every later step means the worker has one in hand.
    void requests.observe(ref, {
      source: "worker",
      at,
      job: {
        phase: step,
        done: step === "done",
        fundsSeenAt: step === "await-native" ? null : at,
        lastTickAt: at,
        claim: null,
      },
    });
  }

  /** A driver's run rejected: the worker's own sighting of the request, with no verdict. The
   *  reducer keeps the status; the next read of the job blob carries the worker's verdict. */
  function recordDriverFailure(ref: RequestRef, reason: string): void {
    const at = Date.now();
    void requests.observe(ref, {
      source: "worker",
      at,
      job: {
        phase: "failed",
        done: false,
        lastError: reason,
        fundsSeenAt: null,
        lastTickAt: at,
        claim: null,
      },
    });
  }

  /** Core's state reaches the record as core's own observation; a key with no record yet (the
   *  first state of a start) is dropped, and the record is created from `lastState`. */
  function observePaymentState(state: PaymentState, ref: RequestRef | undefined): void {
    lastState.value = state;
    if (ref !== undefined) void requests.observe(ref, { source: "core", at: Date.now(), state });
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
      const estimate = estimateSourceAmount(
        deposit.amount,
        depositTokenOf(live.value.route),
        sourceSymbol,
      );
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
    const world = mock.value ?? live.value;
    if (!world) return;
    const tradeN = world.tradeN;
    const ref = requestRefOf(world.sourceId, tradeN);
    try {
      const state = lastState.value;
      // Core's first state arrived before the record existed; the snapshot starts where it
      // would have moved it.
      const opening =
        state === null
          ? null
          : fundingProgressSignalForPaymentState(progressProviderForSource(world.sourceId), state);
      const progress =
        opening === null
          ? initialProgress(startedAt)
          : advanceFundingProgressSnapshot(initialProgress(startedAt), {
              ...opening,
              at: startedAt,
            });
      // What the buyer pays: the fiat quote for a Meld request, the source-coin figure otherwise.
      const sourceDisplay = isMeldSourceId(world.sourceId)
        ? quoted.value
          ? {
              sourceAmount: quoted.value.send,
              sourceSymbol: quoted.value.symbol,
              ...(quoted.value.fee != null ? { sourceFee: quoted.value.fee } : {}),
              ...(quoted.value.provider ? { sourceProvider: quoted.value.provider } : {}),
              ...(quoted.value.transactionFee != null
                ? { sourceTransactionFee: quoted.value.transactionFee }
                : {}),
              ...(quoted.value.networkFee != null
                ? { sourceNetworkFee: quoted.value.networkFee }
                : {}),
              ...(quoted.value.partnerFee != null
                ? { sourcePartnerFee: quoted.value.partnerFee }
                : {}),
              ...(quoted.value.chainFee != null ? { sourceChainFee: quoted.value.chainFee } : {}),
              ...(quoted.value.mintFee != null ? { sourceMintFee: quoted.value.mintFee } : {}),
            }
          : null
        : sourceDisplayForRecord();
      // The deposit window's deadline; the list and the reconcile judge expiry from the record.
      const depositExpiresAt =
        state?.phase === "awaiting-deposit" ? (state.deposit.expiresAt ?? 0) : 0;
      const deposit = state && "deposit" in state && state.deposit ? state.deposit : null;
      const record: TopUpRecord = {
        schema: 2,
        kind: "top-up",
        ref,
        rev: 0,
        updatedAt: startedAt,
        amountHuman: amountHuman.value,
        chain: lastQuoteParams.chain,
        asset: lastQuoteParams.asset,
        ...(sourceDisplay ?? {}),
        startedAt,
        ...(deposit ? { depositAddress: deposit.address } : {}),
        progress,
        tradeN,
        // The session's source id; a resume re-enters under it.
        sourceId: world.sourceId,
        // Only a Meld request has these; the crypto rail leaves them null.
        ...(meldFundingRequestId ? { meldFundingRequestId } : {}),
        ...(isMeldSourceId(world.sourceId) && meldRegionCountry
          ? { meldCountry: meldRegionCountry }
          : {}),
        ...(meldServiceProvider ? { meldServiceProvider } : {}),
        ...(depositExpiresAt > 0 ? { depositExpiresAt } : {}),
        route: routeOf(effectiveSourceId(ref)),
        ...(deposit
          ? {
              deposit: {
                address: deposit.address,
                amount: deposit.amount.toString(),
                formatted: deposit.formatted,
                assetSymbol: deposit.assetSymbol,
                expiresAt: deposit.expiresAt,
              },
            }
          : {}),
        deadline:
          depositExpiresAt > 0
            ? { depositExpiresAt, source: "rail" }
            : {
                depositExpiresAt: startedAt + depositWindowFor(routeOf(effectiveSourceId(ref))),
                source: "route",
              },
        handoff: await world.handoffPayload(),
        conversion: world.route,
        refundAddress: world.refundAddress ?? undefined,
        status: { kind: "awaiting-deposit" },
        rail: {
          provider: railProviderOf(world.sourceId),
          status: "waiting",
          stage: "waiting",
          updatedAt: startedAt,
        },
        witnesses: {},
      };
      await requests.create(ref, record);
    } catch (e) {
      console.warn(
        `[coinage] request record write failed (it will not be re-openable): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Cancel tombstones the record through the reducer; the sweep deletes it later. Awaited: the
   *  tombstone is durable before the world comes down. False when the reducer refused: the record
   *  is past its deposit and stays active, and the worker keeps its job. */
  async function tombstoneActiveFlow(ref: RequestRef, depositExpiresAt: number): Promise<boolean> {
    if (!requests.has(ref)) return true;
    await requests.observe(ref, {
      source: "user",
      at: Date.now(),
      event: "cancelled",
      depositExpiresAt,
    });
    if (requests.get(ref)?.status.kind !== "cancelled") {
      console.warn(`[coinage] cancel refused: request #${ref.tradeN} is past its deposit`);
      return false;
    }
    console.warn(`[coinage] request #${ref.tradeN} tombstoned (cancelled; deposit window watched)`);
    void cancelWorkerJob(workerSessionId(ref.sourceId, ref.tradeN));
    void reconcileBackground(); // drops the row
    return true;
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

  /** A claim landed: the request becomes history, with the amount the claim swept. */
  function markSettled(
    ref: RequestRef | undefined = foregroundRef ?? undefined,
    claimed = requests.claimedBase,
    settledAt = Date.now(),
  ) {
    if (ref === undefined) return;
    void requests
      .observe(ref, {
        source: "worker",
        at: settledAt,
        job: {
          phase: "done",
          done: true,
          fundsSeenAt: settledAt,
          lastTickAt: settledAt,
          claim: { phase: "claimed", amount: claimed?.toString(), at: settledAt },
        },
      })
      .then(() => reconcileBackground()) // refreshes the list
      .catch((e: unknown) => {
        console.warn("[coinage] could not record the finished purchase:", e);
      });
  }

  /** Every open top-up's record, newest first, once the store has caught up with the host. */
  async function readAllRequests(): Promise<TopUpRecord[]> {
    await requests.reconcile("refresh");
    return requests.openTopUps;
  }

  /** The top-ups the app acts on. Tombstoned requests are excluded; only the sweep reads them. */
  function openRequests(): Promise<TopUpRecord[]> {
    return readAllRequests();
  }
  /** Gets every open request converting again and puts nothing on screen; the boot passes
   *  `"boot"`, a route mounting again is a refresh. */
  async function resumeOpenRequests(reason: "boot" | "refresh" = "refresh"): Promise<void> {
    if (!isHosted()) return; // mock flows persist nothing; there is nothing to pick up
    // reconcileBackground applies the worker's jobs; a purchase claimed off screen reaches history.
    await reconcileBackground(reason);
  }

  /** Brings an off-screen request to the front from the record in memory, never behind a
   *  reconcile: builds its world and resumes its session. A record memory lacks is read from the
   *  host once first. */
  async function openRequest(ref: RequestRef): Promise<boolean> {
    let record = requests.get(ref);
    if (record === undefined) {
      await requests.reconcile("refresh");
      record = requests.get(ref);
    }
    if (record === undefined || !isTopUp(record) || record.status.kind === "cancelled") {
      return false;
    }
    try {
      return await enterRequest(record);
    } finally {
      // The store catches up behind the open, whatever came of it.
      void reconcileBackground();
    }
  }

  async function enterRequest(record: TopUpRecord): Promise<boolean> {
    const { ref } = record;
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
      // On screen from its record at once; the world builds behind it.
      requests.setForeground(ref);
      const status = requests.get(ref)?.status.kind ?? "?";
      console.warn(
        `[coinage] reopen request #${record.tradeN}: funded=${record.funded ?? "no"} status=${status} submitted=${record.meldSubmittedAt !== undefined}`,
      );
      const epoch = quoteEpoch;
      // Core's stale bound is the record's own window: the rail's deadline when it set one, the
      // route's otherwise.
      const { deadline } = record;
      const staleFlowMs =
        deadline.depositExpiresAt === null
          ? depositWindowFor(record.route)
          : deadline.depositExpiresAt - record.startedAt;
      // Re-enter under the record's own trade and source id, on the tier the record froze at
      // quote time; a record from before tiers were recorded is a pool one. No decision here.
      const world = await createLiveWorld(
        epoch,
        staleFlowMs,
        recordedRoute(record.handoff ?? {}),
        record.tradeN,
        undefined,
        record.sourceId as SourceId | undefined,
      );
      if (!world) return false;
      if (world.session.peek() === null) {
        // A record with no slot: keep it, note the conflict on it, and fall back to a fresh entry.
        world.dispose();
        console.warn(
          `[coinage] reopen request #${record.tradeN}: no flow slot to resume; the record is kept`,
        );
        void requests.flag(ref, "core slot missing on resume");
        reset();
        return false;
      }
      live.value = world;
      // Display context for the journey; no re-quote on this path.
      quoted.value = {
        send: record.sourceAmount ?? "",
        symbol: record.sourceSymbol ?? record.asset,
        fee: record.sourceFee ?? null,
        provider: record.sourceProvider ?? null,
        transactionFee: record.sourceTransactionFee ?? null,
        networkFee: record.sourceNetworkFee ?? null,
        partnerFee: record.sourcePartnerFee ?? null,
        chainFee: record.sourceChainFee ?? null,
        mintFee: record.sourceMintFee ?? null,
        nativeAmount: null,
        sourceAsset: record.asset,
        sourceChain: record.chain,
      };
      sub?.unsubscribe();
      sub = world.session.subscribe((state) => {
        observePaymentState(state, ref);
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
          meldServiceProvider = record.meldServiceProvider ?? null;
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
      const expired = requests.get(ref)?.status.kind === "expired";
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
    void markDepositSkipped();
    try {
      const tradeN = live.value.tradeN;
      const faucetRef = requestRefOf(live.value.sourceId, tradeN);
      // The world's route fixes the asset the faucet sends: the one the pipeline reads the burner
      // for.
      const sent = await fundFromFaucet({
        address: s.deposit.address,
        amount: s.deposit.amount,
        route: live.value.route,
      });
      faucetState.value = "sent";
      // The transfer is in a block: the chain's own sighting of the deposit.
      await requests.observe(faucetRef, {
        source: "chain",
        at: Date.now(),
        burnerNative: sent.toString(),
        finality: "finalized",
        via: "faucet",
      });
      driveFunding(); // joins the running leg, or restarts one that had failed
    } catch (e: unknown) {
      faucetState.value = "idle";
      requests.setTransientError({
        message: e instanceof Error ? e.message : String(e),
        at: Date.now(),
        source: "faucet",
      });
    }
  }

  // Mock world controls (browser demo)
  /** One beat of the demo's simulated payment: long enough to watch a step land, short enough
   *  that a demo does not stall on it. */
  const SIMULATED_PAYMENT_STEP_MS = 2_500;

  function simulateDeposit() {
    void markDepositSkipped();
    if (mock.value && amountBase.value !== null)
      mock.value.harness.setSettlementBalance(amountBase.value);
  }

  /** Demo Skip was pressed: record it on the request so a re-open never offers Skip again.
   *  Stamped through the central store, persisted before it resolves. */
  async function markDepositSkipped(): Promise<void> {
    if (foregroundRef === null || requests.depositSkipped) return;
    await requests.markDepositSkipped(foregroundRef);
  }

  /** The buyer finished in the widget: the stamp hands the screen over to the journey now, not on
   *  `transaction_seen`, which can precede a 3DS/OTP challenge that still needs the iframe.
   *  Persisted before returning; a re-open reads it to keep the paid widget hidden. */
  async function markMeldSubmitted(): Promise<void> {
    if (foregroundRef === null || requests.meldSubmitted) return;
    await requests.markMeldSubmitted(foregroundRef);
  }

  /** Credits the settled Meld payment into the coinage leg, once. A no-op in the host world. */
  function creditMeldSettlement() {
    if (meldCredited) return;
    meldCredited = true;
    simulateDeposit();
  }

  /** Timers driving the demo's simulated payment; cleared with the world they belong to. */
  let simulatedPaymentTimers: ReturnType<typeof setTimeout>[] = [];
  function stopSimulatedPayment() {
    for (const timer of simulatedPaymentTimers) clearTimeout(timer);
    simulatedPaymentTimers = [];
  }

  /**
   * Demo Skip: play the whole fiat payment through, from the buyer leaving the widget to the
   * provider settling, instead of dropping a deposit on the burner mid-journey.
   *
   * Skipping straight to the deposit left the timeline starting halfway: the payment steps never
   * happened, so the journey opened on "Approved" with nothing behind it. Feeding the record the
   * observations the status poll would have written gets the stepper from Started to Added, which
   * is the point of a demo. The record counts the steps either way, so the real pipeline overtakes
   * the play without the stepper ever stepping backwards.
   *
   * The poll is stopped first. It re-reads the rail on its own cadence and would overwrite these
   * stages with whatever the (unpaid, or faked) request really says.
   */
  function simulateMeldPayment(): void {
    const ref = foregroundRef;
    if (!isDemoBuild() || method.value === "crypto" || ref === null) return;
    stopSimulatedPayment();
    requests.stopMeldPoll();
    let beat = 0;
    const step = (run: () => void) => {
      beat += 1;
      simulatedPaymentTimers.push(setTimeout(run, SIMULATED_PAYMENT_STEP_MS * beat));
    };
    const report = (status: "receiving" | "complete") =>
      void requests.observe(ref, {
        source: "provider",
        provider: "meld",
        at: Date.now(),
        result: { status },
      });
    // The buyer finishes in the widget: the journey takes over from the iframe.
    void markMeldSubmitted();
    // The provider sees the transaction, then approves it.
    step(() => report("receiving"));
    step(() => report("complete"));
    // The conversion runs, and the deposit that pays for it arrives: the mock world fakes it
    // through `creditMeldSettlement`, the hosted demo needs the faucet. The real pipeline takes
    // the journey the rest of the way.
    step(() => {
      if (mock.value) creditMeldSettlement();
      else void fundFaucet();
    });
  }

  /** The provider's hosted pay page for the request on screen, or null. */
  const meldPayUrl = computed<string | null>(() => {
    // Hidden once the buyer finished the widget.
    if (requests.meldSubmitted) return null;
    const state = lastState.value;
    const fromRail = state?.phase === "awaiting-deposit" ? state.deposit.payUrl : undefined;
    return fromRail ?? meldResumeWidgetUrl.value;
  });

  /** Starts the store's poll of the Meld payment's status for the request on screen. Idempotent;
   *  a no-op until the request has a ref, a client and a funding-request id. */
  function pollMeldStatus(): void {
    if (foregroundRef === null || !meldStatusClient || !meldFundingRequestId) return;
    requests.startMeldPoll(foregroundRef, meldStatusClient, meldFundingRequestId);
  }
  function approveClaim() {
    mock.value?.handoff.confirmConsent();
  }
  /** Re-drives a recoverably failed request once the store confirms the failure; a request with
   *  no record retries core alone. */
  function retry() {
    const s = session();
    if (!s) return;
    const confirmed =
      foregroundRef === null ? Promise.resolve(true) : requests.retry(foregroundRef);
    void confirmed.then((ok) => {
      if (!ok) return;
      return s
        .retry()
        .then(() => console.info(`[coinage] retry() resolved, phase now ${s.getState().phase}`))
        .catch((e: unknown) => console.error("[coinage] retry() threw:", e));
    });
  }

  /** Abandons the on-screen top-up. The record is tombstoned first; only then does core's
   *  cancel() clear the flow slot and the world come down. A record the reducer refuses to cancel
   *  keeps its slot and its world. Funds are never touched. */
  async function cancelTopUp(): Promise<boolean> {
    // Declined, not failed: the request still stands.
    if (cancelling.value || requests.claiming || resuming.value || !cancelReady.value) return false;
    cancelling.value = true;
    cancelNotice.value = null;
    try {
      // Last look before anything irreversible: funds on the burner or in the worker's hands mean
      // a purchase in progress. Refuse (the store latched it funded) and drive it. A read that
      // cannot confirm the burner is empty declines the cancel.
      const world = live.value;
      if (world && foregroundRef !== null) {
        const verdict = await requests.cancel(foregroundRef, {
          readBurner: () => world.readBurnerDepositOnAh(),
        });
        if (verdict === "refused") {
          console.warn("[coinage] cancel refused: the burner already holds funds");
          driveFunding();
          return false;
        }
        if (verdict === "unconfirmed") {
          console.warn("[coinage] cancel declined: could not confirm the burner is empty");
          return false;
        }
      }
      // Withdraw the pay page on the adapter too. A local cancel alone leaves the adapter serving a
      // payable page for this request, so its link could still be paid against a top-up the buyer
      // was told was over. If the adapter refuses because a payment is already on its way, respect
      // it and keep the request: telling the buyer it is cancelled while their money moves is the
      // one thing not to say. A transport error fails open (a still-served page is the pre-existing
      // behaviour), so a dead adapter never strands the cancel.
      const meldRequestId = meldFundingRequestId;
      if (meldStatusClient !== null && meldRequestId !== null) {
        try {
          const outcome = await step(
            "withdraw the pay page",
            15_000,
            meldStatusClient.cancel(meldRequestId),
          );
          if (outcome.outcome === "not-cancellable") {
            cancelNotice.value =
              "Your payment is already on its way and can no longer be cancelled. It will finish on its own.";
            console.warn("[meld] cancel refused by the adapter: a payment is already in flight");
            return false;
          }
        } catch (e) {
          console.warn(
            `[meld] adapter cancel failed (cancelling locally anyway): ${e instanceof Error ? e.message : String(e)}`,
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
      if (ref !== null) {
        try {
          if (!(await tombstoneActiveFlow(ref, depositExpiresAt))) {
            // The record is past its deposit: a purchase in progress, driven as the refused
            // read is.
            driveFunding();
            return false;
          }
        } catch (e) {
          // An unwritable tombstone leaves the record active.
          console.warn(
            `[coinage] tombstone write failed (record left as-is): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      try {
        // While the world is still up: cancel() needs the session to clear its slot.
        if (s) await step("cancel top-up", 20_000, s.cancel());
      } catch (e) {
        // The slot clear is best effort; everything below still detaches the request.
        console.warn(
          `[coinage] cancel: core cancel failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
        );
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

  // Loads the bulk per-country corridors; only a real catalog is adopted so a cold/empty read greys nothing.
  async function loadSupportedCorridors(): Promise<void> {
    const map = await fetchSupportedCorridors();
    if (map !== null && map.size > 0) corridorByCountry.value = map;
  }

  return {
    // state
    amountHuman,
    amountBase,
    method,
    meldCountry,
    quoted,
    quoteError,
    meldMethodUnavailable,
    supportedCountries,
    corridorByCountry,
    meldCorridor,
    meldResumeWidgetUrl,
    meldPayUrl,
    sourcePrice,
    loading,
    resuming,
    faucetState,
    revealRefund,
    canSkipDeposit,
    cancelReady,
    cancelling,
    cancelNotice,
    mock,
    live,
    refundAddress,
    revealRefundKey,
    recoverRefundKeyFor,
    // derived helpers
    isFaucetConfigured,
    amountStatus,
    // actions
    setAmount,
    setMethod,
    setMeldCountry,
    loadSupportedCountries,
    loadSupportedCorridors,
    fetchQuote,
    fetchMeldQuote,
    start,
    reset,
    /** Drops and rebuilds the chain clients in place. */
    reconnectChains,
    resumeOpenRequests,
    openRequests,
    openRequest,
    journeySteps,
    fundFaucet,
    simulateDeposit,
    simulateMeldPayment,
    pollMeldStatus,
    markMeldSubmitted,
    approveClaim,
    retry,
    cancelTopUp,
  };
});
