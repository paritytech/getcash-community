// The state director for dev and demo builds: Ctrl+Shift+N / P cycles presentation scenes that
// drive the requests store with the observations a real purchase would produce; Ctrl+Shift+R
// reloads the page.

import type { PaymentState, SourceId } from "@getsome/core";
import { SOURCE_CONFIG_BY_ID, type SourceFloorResult } from "@getsome/chainflip";
import { SOURCE_CHAINS } from "~~/lib/config";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  progressProviderForSource,
} from "../funding/progress";
import { CRYPTO_SOURCE_ID } from "../funding/source-ids";
import {
  DEFAULT_DEPOSIT_WINDOW_MS,
  railProviderOf,
  routeOf,
  type Observation,
  type RequestRecord,
} from "../funding/requests/model";
import { createMockCoinageSession } from "~~/lib/coinage";
import { isDemoBuild } from "./demo";
import {
  previewQuote,
  previewTopUp,
  previewTopUpHistory,
  previewTopUpScene,
  type PreviewTopUpScene,
} from "./dev-preview-top-ups";
import type { FundingTopUp, StoredQuote } from "../funding/top-ups";
import { previewStage, type PreviewStage } from "./dev-preview-stage";
import { useFlowStore } from "../stores/flow";
import { useOffersStore } from "../stores/offers";
import { useRequestsStore } from "../stores/requests";
import { useSessionStore } from "../stores/session";
import type { RequestRef } from "../utils/request-index";

type Session = ReturnType<typeof useSessionStore>;
type Flow = ReturnType<typeof useFlowStore>;

const DOT = 10_000_000_000n;

function floor(sourceId: SourceId, minimumBaseUnits: bigint, worth: bigint): SourceFloorResult {
  return {
    kind: "floor",
    floor: { sourceId, minimumBaseUnits, minimumEgressBaseUnits: worth, etaSeconds: 600 },
  };
}

/** Canned floors for the selection scenes. Bitcoin's is above the 100 CASH purchase and
 *  Ethereum USDC is unanswered. */
const FLOORS = new Map<SourceId, SourceFloorResult>([
  ["btc", floor("btc", 40_000n, 16n * DOT)],
  ["eth", floor("eth", 10n ** 16n, (25n * DOT) / 10n)],
  ["usdc-eth", { kind: "unavailable", reason: "preview: unanswered" }],
  ["usdt-eth", floor("usdt-eth", 20_000_000n, 5n * DOT)],
  ["sol-solana", floor("sol-solana", 68_000_000n, (17n * DOT) / 10n)],
  ["usdc-solana", floor("usdc-solana", 10_000_000n, (25n * DOT) / 10n)],
  ["usdt-solana", floor("usdt-solana", 10_000_000n, (25n * DOT) / 10n)],
  ["trx-tron", floor("trx-tron", 30_000_000n, 2n * DOT)],
  ["usdt-tron", floor("usdt-tron", 10_000_000n, (25n * DOT) / 10n)],
]);

const DEPOSIT = {
  address: "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC",
  amount: 2_934_713_048n,
  formatted: "0.29",
  assetSymbol: "PAS",
  expiresAt: 0,
} as const;

/** The canned quote for 5 CASH from Bitcoin. Send and symbol are the source asset's. */
const QUOTED = {
  send: "0.00004545",
  symbol: "BTC",
  nativeAmount: 2_934_713_048n,
  sourceAsset: "BTC",
  sourceChain: "Bitcoin",
};

function awaitingDeposit(
  expiresAt: number = DEPOSIT.expiresAt,
  sourceId: SourceId = "btc",
): PaymentState {
  return {
    phase: "awaiting-deposit",
    sourceId,
    quote: null,
    deposit: { ...DEPOSIT, expiresAt },
  } as PaymentState;
}
function swapping(
  swap: "receiving" | "swapping" | "sending" | "complete",
  sourceId: SourceId = "btc",
): PaymentState {
  return {
    phase: "swapping",
    sourceId,
    quote: null,
    deposit: DEPOSIT,
    swap,
  } as PaymentState;
}
function working(
  step: "awaiting-consent" | "verifying" | "minting",
  sourceId: SourceId = "btc",
): PaymentState {
  const mint = step === "minting" ? { step, attempt: 1, of: 3 } : { step };
  return { phase: "working", sourceId, deposit: DEPOSIT, mint } as PaymentState;
}

interface Scene {
  name: string;
  /** Which container the scene's state is meant to be read in. Derived from the scene's family
   *  when left out; set it only where the name cannot say it (a journey opened on one top-up). */
  stage?: PreviewStage;
  /** `index` is the scene's position in `SCENES`; it keys the scene's synthetic request. */
  apply: (session: Session, flow: Flow, index: number) => void | Promise<void>;
}

/** The canned card quote for 50 CASH: the figures the Meld design frames show. */
const QUOTED_CARD = {
  send: "52.06",
  symbol: "USD",
  provider: "TRANSAK",
  fee: "1.56",
  // The shape real card quotes come back in: a provider fee and our flat cut, no network fee.
  transactionFee: "1.06",
  networkFee: null,
  partnerFee: "0.50",
  // Not Meld's: the swap and teleport up to CASH on People, as the store prices them. Measured
  // against Paseo for this frame's 50 CASH — 0.0343 DOT of Asset Hub fees at the quote's implied
  // rate, plus 0.000043 CASH of execution on People.
  chainFee: "0.0867",
  nativeAmount: null,
  sourceAsset: null,
  sourceChain: null,
};

/** The canned bank quote for 50 CASH: the figures the bank design frames show. */
const QUOTED_BANK = {
  send: "50.55",
  symbol: "EUR",
  fee: "0.55",
  networkFee: "0.05",
  nativeAmount: null,
  sourceAsset: null,
  sourceChain: null,
};

/**
 * A live catalog, as the adapter answers `/supported`: the regions the picker lists and what each
 * corridor charges.
 *
 * Priced in GBP against a £12.50 purchase, so one region of each kind is on screen at once: ones
 * that can be paid from, one whose minimum is above this purchase (Guernsey, £40), and ones the
 * rail does not route at all. Without a corridor map the picker has no minimums to show and
 * nothing to grey, which is what a deck run against no adapter would otherwise draw.
 */
const PREVIEW_COUNTRIES = [
  { country: "GB", name: "United Kingdom" },
  { country: "DE", name: "Germany" },
  { country: "PT", name: "Portugal" },
  { country: "FR", name: "France" },
  { country: "ES", name: "Spain" },
  { country: "IT", name: "Italy" },
  { country: "NL", name: "Netherlands" },
  { country: "IE", name: "Ireland" },
  { country: "AT", name: "Austria" },
  { country: "BE", name: "Belgium" },
  { country: "FI", name: "Finland" },
  { country: "GR", name: "Greece" },
  { country: "LU", name: "Luxembourg" },
  { country: "BR", name: "Brazil" },
  { country: "GG", name: "Guernsey" },
  { country: "VA", name: "Vatican City" },
  { country: "EC", name: "Ecuador" },
];

/** The SEPA rails, every one of them routed and priced the same: the bank picker lists its rails
 *  whether or not the catalog priced them, and a rail missing from this fixture would grey as
 *  unsupported for no reason a reviewer could act on. */
const SEPA_PREVIEW = ["DE", "PT", "FR", "ES", "IT", "NL", "IE", "AT", "BE", "FI", "GR", "LU"];

function previewMethod(category: "card" | "bank", min: string, currency: string) {
  const paymentMethodType = category === "card" ? "CREDIT_DEBIT_CARD" : "SEPA";
  return { paymentMethodType, category, min, max: "5000", currency, providers: ["TRANSAK"] };
}

/** `[country, fiat, the card minimum, the bank minimum]`; a null minimum is a rail that does not
 *  reach that region, which the picker greys as unsupported. */
const PREVIEW_CORRIDORS: readonly [string, string, string | null, string | null][] = [
  ["GB", "GBP", "4.00", "4.00"],
  ...SEPA_PREVIEW.map((country): [string, string, string, string] => [
    country,
    "EUR",
    "4.00",
    "4.00",
  ]),
  ["BR", "BRL", "26.00", null],
  ["GG", "GBP", "40.00", "40.00"],
  ["VA", "EUR", null, null],
  ["EC", "USD", null, null],
];

/** Stages that catalog on the session, the way `loadSupported*` would once the adapter answers. */
function meldCatalog(session: Session) {
  session.supportedCountries = [...PREVIEW_COUNTRIES];
  session.corridorByCountry = new Map(
    PREVIEW_CORRIDORS.map(([country, fiat, card, bank]) => [
      country,
      {
        country,
        fiat,
        methods: [
          ...(card ? [previewMethod("card", card, fiat)] : []),
          ...(bank ? [previewMethod("bank", bank, fiat)] : []),
        ],
      },
    ]),
  );
}

/** What the record shows for each source the scenes use. A source not named here is displayed as
 *  its swap config names it. */
const DISPLAY: Partial<Record<SourceId, { chain: string; asset: string }>> = {
  btc: { chain: "Bitcoin", asset: "BTC" },
  "usdt-tron": { chain: "Tron", asset: "USDT" },
  "meld-card": { chain: "Meld", asset: "Card" },
  "meld-bank": { chain: "Meld", asset: "Bank" },
};

/** What each rail says it will take, before anything is detected; the store words these the same
 *  way when it opens a real request. */
const ESTIMATE: Partial<Record<SourceId, string>> = {
  "meld-card": "≈ minutes after you pay",
  "meld-bank": "1-2 business days after you pay",
};

/** How long the rail's own leg is expected to take, where the store sizes it per method
 *  (`initialProgress`): a card confirms within minutes, a bank transfer takes business days. */
const INGRESS_MS: Partial<Record<SourceId, number>> = {
  "meld-card": 5 * 60_000,
  "meld-bank": 24 * 60 * 60_000,
};

/** The scene's synthetic request: its record and the handle the scene feeds observations through. */
interface PreviewRequest {
  ref: RequestRef;
  /** The stamp for the scene's `step`th observation, in order. */
  at: (step: number) => number;
  observe: (observation: Observation) => Promise<void>;
}

/** Creates the scene's request, awaiting its deposit, and puts it on screen. The deck cycles, so
 *  a request the scene made before is removed first. */
async function previewRequest(
  session: Session,
  opts: {
    sourceId: SourceId;
    index: number;
    /** Which of the scene's requests this is; a list scene seeds several. */
    slot?: number;
    /** Leave the request off screen, for a scene whose subject is the list rather than one
     *  request's own screen. */
    foreground?: boolean;
    deposit?: { expiresAt: number };
    /** What the buyer sent, as the record names it. Defaults to what the source id implies; a
     *  crypto record's source id is the rail's, so the coin has to be said separately. */
    display?: { chain: string; asset: string };
    /** CASH asked for. Defaults to the session's, which every single-request scene has set. */
    amountHuman?: string;
    /** How long ago the request was opened. */
    startedMinutesAgo?: number;
    /** The rail's persisted quote: what the list and a reopened journey read their money row off,
     *  and the split the fee breakdown behind it itemizes. */
    quote?: StoredQuote;
    /** The buyer's region, as a fiat record keeps it. */
    meldCountry?: string;
    /** What the Meld create call captured: the provider that took the payment, and the funding
     *  request's id. The record keeps both, as a real card request's does, and the failed journey
     *  shows the id as the payment's reference. */
    meld?: { serviceProvider: string; fundingRequestId: string };
  },
): Promise<PreviewRequest> {
  const requests = useRequestsStore();
  const { sourceId } = opts;
  const ref: RequestRef = { sourceId, tradeN: 900 + opts.index * 10 + (opts.slot ?? 0) };
  if (requests.has(ref)) await requests.remove(ref);
  const now = Date.now();
  const startedAt = now - (opts.startedMinutesAgo ?? 5) * 60_000;
  const expiresAt = opts.deposit?.expiresAt ?? 0;
  const config = SOURCE_CONFIG_BY_ID.get(sourceId);
  const display =
    opts.display ??
    DISPLAY[sourceId] ??
    (config ? { chain: config.chain, asset: config.asset } : { chain: sourceId, asset: sourceId });
  // As `persistActiveFlow` writes it: the initial snapshot moved by core's first state. The bank
  // transfer's ingress is the store's own day-long one, so its progress crawls as a real one does.
  const provider = progressProviderForSource(sourceId);
  const ingressDurationMs = INGRESS_MS[sourceId];
  const initial = createFundingProgressSnapshot(
    provider.createProfile({
      ...(ingressDurationMs === undefined ? {} : { ingressDurationMs }),
      // As `initialProgress` words it: a transfer is sent, not paid.
      ...(sourceId === "meld-bank" ? { waitingLabel: "Waiting for your transfer" } : {}),
    }),
    { preDetectionEstimateText: ESTIMATE[sourceId] ?? "≈10 min after your transfer" },
  );
  const opening = fundingProgressSignalForPaymentState(provider, awaitingDeposit(0, sourceId));
  const progress =
    opening === null
      ? initial
      : advanceFundingProgressSnapshot(initial, { ...opening, at: startedAt });
  const record: RequestRecord = {
    schema: 2,
    kind: "top-up",
    ref,
    rev: 0,
    updatedAt: now,
    amountHuman: opts.amountHuman ?? session.amountHuman,
    ...display,
    startedAt,
    depositAddress: DEPOSIT.address,
    progress,
    tradeN: ref.tradeN,
    sourceId,
    route: routeOf(sourceId),
    // The adapter's handle, which the bank journey shows as the transfer's reference, and the
    // provider it quoted through, which a concluded one names. Both are defaults: a scene that
    // brought its own quote or meld identity is spread after them, since a scene naming a
    // reference is a scene whose ending is about that reference.
    ...(sourceId === "meld-card" || sourceId === "meld-bank"
      ? {
          meldFundingRequestId: `preview-funding-${ref.tradeN}`,
          sourceProvider: "TRANSAK",
        }
      : {}),
    ...(opts.quote
      ? {
          sourceAmount: opts.quote.amount,
          sourceSymbol: opts.quote.symbol,
          ...(opts.quote.fee ? { sourceFee: opts.quote.fee } : {}),
          ...(opts.quote.provider ? { sourceProvider: opts.quote.provider } : {}),
          ...(opts.quote.transactionFee ? { sourceTransactionFee: opts.quote.transactionFee } : {}),
          ...(opts.quote.networkFee ? { sourceNetworkFee: opts.quote.networkFee } : {}),
          ...(opts.quote.partnerFee ? { sourcePartnerFee: opts.quote.partnerFee } : {}),
          ...(opts.quote.chainFee ? { sourceChainFee: opts.quote.chainFee } : {}),
        }
      : {}),
    ...(opts.meldCountry ? { meldCountry: opts.meldCountry } : {}),
    ...(opts.meld
      ? {
          meldServiceProvider: opts.meld.serviceProvider,
          meldFundingRequestId: opts.meld.fundingRequestId,
        }
      : {}),
    deposit: {
      address: DEPOSIT.address,
      amount: DEPOSIT.amount.toString(),
      formatted: DEPOSIT.formatted,
      assetSymbol: DEPOSIT.assetSymbol,
      expiresAt,
    },
    deadline:
      expiresAt > 0
        ? { depositExpiresAt: expiresAt, source: "rail" }
        : { depositExpiresAt: startedAt + DEFAULT_DEPOSIT_WINDOW_MS, source: "route" },
    status: { kind: "awaiting-deposit" },
    rail: {
      provider: railProviderOf(sourceId),
      status: "waiting",
      stage: "waiting",
      updatedAt: startedAt,
    },
    witnesses: {},
  };
  await requests.create(ref, record);
  if (opts.foreground !== false) requests.setForeground(ref);
  return {
    ref,
    at: (step) => now - 128_000 + step * 1_000,
    observe: (observation) => requests.observe(ref, observation),
  };
}

/** Core's state as the request's own observation. */
async function core(request: PreviewRequest, step: number, state: PaymentState) {
  await request.observe({ source: "core", at: request.at(step), state });
}

/** A rail poll's report that the payment is seen but stuck and retrying: Meld's crypto delivery, or
 *  a deposit the chain is slow to confirm. */
function railDelayed(
  request: PreviewRequest,
  step: number,
  provider: "meld" | "chainflip",
): Observation {
  return {
    source: "provider",
    provider,
    at: request.at(step),
    result: { status: "receiving" },
    delayed: true,
  };
}

/** The worker's job at a step of the pipeline, its deposit in hand. */
function worker(request: PreviewRequest, step: number, phase: string, done = false): Observation {
  const at = request.at(step);
  return {
    source: "worker",
    at,
    job: { phase, done, fundsSeenAt: at, lastTickAt: at, claim: null },
  };
}

/**
 * How far a running preview top-up has got. Named for the rail's own step, because that is what
 * the observations below say and what the progress machine words the card with.
 */
type RunningStage =
  /** Opened, nothing sent yet. */
  | "waiting"
  /** The rail has the payment and is confirming it. */
  | "confirming"
  /** The rail is done and the worker is swapping up to CASH. */
  | "converting"
  /** The swap landed; the host is crediting the balance. */
  | "adding";

interface RunningTopUp {
  /** The rail's own source, as a record keeps it: the crypto rail's own, or a Meld method's. */
  sourceId: SourceId;
  /** CASH asked for. */
  amount: string;
  stage: RunningStage;
  /** What the buyer sent, for the crypto rail, whose source id names the rail rather than the
   *  coin. */
  display?: { chain: string; asset: string };
  /**
   * The rail reported the payment seen but stuck and retrying. Only with `confirming`: the flag
   * belongs to the rail's own leg, and a later observation would move the stage off it.
   */
  delayed?: boolean;
  startedMinutesAgo?: number;
}

/**
 * Seeds a list scene's running top-ups as real records and drives each to its stage through the
 * observations its rail would produce.
 *
 * The rows the scene then shows are the package adapters' own projections, so the card's id is
 * the request's, its status line is whatever the progress machine words that stage as, its amber
 * is `rail.delayed` off the record, and its Fees and Total come from the record's persisted
 * quote. Nothing is left on screen: the subject is the list.
 */
async function seedRunningTopUps(
  session: Session,
  index: number,
  rows: readonly RunningTopUp[],
): Promise<void> {
  const requests = useRequestsStore();
  for (const [slot, row] of rows.entries()) {
    const route = routeOf(row.sourceId);
    const request = await previewRequest(session, {
      sourceId: row.sourceId,
      index,
      slot,
      foreground: false,
      amountHuman: row.amount,
      startedMinutesAgo: row.startedMinutesAgo ?? 12,
      ...(row.display ? { display: row.display } : {}),
      ...(() => {
        const quote = previewQuote(route, row.amount);
        return quote === undefined ? {} : { quote };
      })(),
      ...(route === "crypto"
        ? {}
        : {
            meldCountry: "US",
            meld: {
              ...PREVIEW_MELD,
              fundingRequestId: PREVIEW_MELD_IDS[slot % PREVIEW_MELD_IDS.length]!,
            },
          }),
    });
    // Each step is the one the rail reports, in the order it reports them, so the record passes
    // through the same states a real one does on the way to this stage.
    await core(request, 0, awaitingDeposit(0, row.sourceId));
    if (row.stage !== "waiting") {
      await core(request, 1, swapping("receiving", row.sourceId));
      // Whose poll reported the delay. Not `railProviderOf`: the crypto rail's own source runs
      // under the manual provider, and it is Chainflip that watches the deposit confirm.
      if (row.delayed === true) {
        await request.observe(railDelayed(request, 2, route === "crypto" ? "chainflip" : "meld"));
      }
    }
    if (row.stage === "converting" || row.stage === "adding") {
      await core(request, 3, swapping("complete", row.sourceId));
      await request.observe(worker(request, 4, "swap"));
    }
    // The worker's job done is what moves the record to claiming, which is the stage the shared
    // "Adding to your balance" label belongs to.
    if (row.stage === "adding") await request.observe(worker(request, 5, "claim", true));
  }
  requests.leave();
}

/** Baseline for every scene: 5 CASH quoted, journey-clean, nothing on screen. */
function base(session: Session, flow: Flow) {
  session.setAmount("5");
  // The scenes model the crypto rail; a card/bank run before cycling scenes must not leak its
  // method into how the canned BTC quote is read.
  session.method = "crypto";
  session.quoted = { ...QUOTED };
  session.resuming = false;
  session.revealRefund = false;
  useRequestsStore().fundingNotice = null;
  useRequestsStore().setTransientError(null);
  useRequestsStore().leave();
  // The records too: a scene lists what it seeded, never what its neighbour did.
  useRequestsStore().clearSandbox();
  flow.step = "amount";
  flow.confirmingCancel = false;
  flow.previewDrillIn = null;
  session.supportedCountries = null;
  session.corridorByCountry = null;
  // The shell reads the adapters again unless a top-ups scene says otherwise.
  previewTopUpScene.value = null;
  // Bitcoin, matching the canned quote.
  flow.srcChainIndex = 0;
  flow.srcAssetIndex = 0;
}

/** Baseline for the card-journey scenes: the Meld quote and method the design frames show. */
function cardJourney(session: Session, flow: Flow) {
  base(session, flow);
  session.setAmount("50");
  session.method = "card";
  session.quoted = { ...QUOTED_CARD };
}

/**
 * Baseline for the card summary scenes: a £12.50 purchase against the staged catalog.
 *
 * Priced in GBP so the picker has a region it can call out of reach — a minimum only binds when
 * it is written in the currency the quote is priced in.
 */
function cardSummary(session: Session, flow: Flow) {
  base(session, flow);
  session.setAmount("12");
  session.method = "card";
  session.setMeldCountry("GB");
  session.quoted = {
    ...QUOTED_CARD,
    send: "12.50",
    symbol: "GBP",
    fee: "0.38",
    transactionFee: "0.26",
    partnerFee: "0.12",
  };
  meldCatalog(session);
}

/** Baseline for the bank summary scenes: the bank frames' own quote, against the same catalog. */
function bankSummary(session: Session, flow: Flow) {
  bankJourney(session, flow);
  session.setMeldCountry("PT");
  meldCatalog(session);
}

/** What the card scenes' create call captured, as the record keeps it. The id abbreviates to the
 *  "a1f9-4c2e" the design frames show, so the journey's reference row renders as drawn. */
const PREVIEW_MELD = {
  // Meld's own casing, so the scenes exercise the name the row has to re-case.
  serviceProvider: "TRANSAK",
  fundingRequestId: "a1f9c3d2-7b44-4e10-9f21-00ab9e4c2e",
};

/** One funding-request id per fiat row a list scene seeds; two rows sharing one would read as the
 *  same payment. */
const PREVIEW_MELD_IDS = [
  PREVIEW_MELD.fundingRequestId,
  "c4d8e2b0-6a15-4f73-8be9-25c1f0a7d346",
  "e9b3f7a4-1c58-4d20-97af-63d2b8e4c015",
] as const;

/** Baseline for the selection scenes: 100 CASH, floors already learned, source set directly. */
function selection(session: Session, flow: Flow) {
  base(session, flow);
  session.setAmount("100");
  session.quoted = { ...QUOTED, nativeAmount: 58_694_260_960n };
  const offers = useOffersStore();
  offers.floors = FLOORS;
  // The paused scene turns the demo fallback off and the rail-off scene turns the rail off; every
  // other scene gets the build's own settings.
  offers.demoFallback = isDemoBuild();
  offers.railEnabled = true;
  flow.srcChainIndex = 1; // Ethereum
  flow.srcAssetIndex = 0;
}

/** Baseline for the bank-journey scenes: the Meld quote and method the bank frames show. */
function bankJourney(session: Session, flow: Flow) {
  base(session, flow);
  session.setAmount("50");
  session.method = "bank";
  session.setMeldCountry("DE");
  session.quoted = { ...QUOTED_BANK };
}

/** The bank scenes' request, with the transfer the buyer says they have sent. The rail cannot see
 *  an inbound transfer until it lands, so this assertion is all the journey opens on.
 *
 * The scene installs a world with it: cancelling reads one, so the screen's Cancel is only offered
 * where a request could really be withdrawn. Without it the deck would show a journey no live run
 * ever looks like. */
async function bankTransfer(s: Session, f: Flow, index: number): Promise<PreviewRequest> {
  bankJourney(s, f);
  const r = await previewRequest(s, { sourceId: "meld-bank", index });
  await r.observe({ source: "user", at: r.at(0), event: "meld-submitted" });
  s.mock = await createMockCoinageSession({
    recipient: DEPOSIT.address,
    amount: s.amountBase ?? 50_000_000n,
    sourceId: "meld-bank",
    tradeN: r.ref.tradeN,
  });
  return r;
}

/** A bank transfer the rail ended, as `getMeldStatus` reports it: the ending's own code and the
 *  adapter's message for it. The journey re-words the ones written for a card. */
async function bankEnding(
  s: Session,
  f: Flow,
  index: number,
  code: string,
  message: string,
): Promise<PreviewRequest> {
  const r = await bankTransfer(s, f, index);
  await r.observe({
    source: "provider",
    provider: "meld",
    at: r.at(1),
    result: {
      status: "failed",
      depositFailure: { reason: { code, message }, kind: "deposit-rejected" },
      raw: code,
    },
  } as Observation);
  return r;
}

/** The card scenes' request, once the provider has seen the payment. */
async function cardPayment(s: Session, f: Flow, index: number): Promise<PreviewRequest> {
  cardJourney(s, f);
  // The scenes never run createSession, which is what captures these on a real payment; the
  // record carries them here instead, as a real card request's does.
  const r = await previewRequest(s, { sourceId: "meld-card", index, meld: PREVIEW_MELD });
  await core(r, 0, swapping("receiving", "meld-card"));
  return r;
}

/** The crypto scenes' request, once the worker has its deposit and is at `phase`. */
async function pipeline(
  s: Session,
  f: Flow,
  index: number,
  phase: string,
): Promise<PreviewRequest> {
  base(s, f);
  const r = await previewRequest(s, { sourceId: "btc", index });
  await r.observe(worker(r, 0, phase));
  return r;
}

/** The crypto scenes' request, claimed by the worker and prompting core's consent. */
async function claimConsent(s: Session, f: Flow, index: number): Promise<PreviewRequest> {
  base(s, f);
  const r = await previewRequest(s, { sourceId: "btc", index });
  await r.observe(worker(r, 0, "done", true));
  await core(r, 1, working("awaiting-consent"));
  return r;
}

/** Decimal string -> base-units string, for the refund amounts below. */
function toBaseUnits(decimal: string, decimals: number): string {
  const [whole = "0", frac = ""] = decimal.split(".");
  const joined = `${whole}${frac.padEnd(decimals, "0").slice(0, decimals)}`;
  return joined.replace(/^0+(?=\d)/, "");
}

/** A refunded failure on `sourceId`: the return-funds copy varies per chain and asset, so every
 *  source gets its own scene. The screen reads the key off the mock world the scene installs. */
function refunded(sourceId: SourceId, send: string) {
  const source = SOURCE_CONFIG_BY_ID.get(sourceId);
  if (!source) throw new Error(`preview: no source config for ${sourceId}`);
  const chainIndex = SOURCE_CHAINS.findIndex((c) => c.chain === source.chain);
  const assetIndex = (SOURCE_CHAINS[chainIndex]?.assets as readonly string[] | undefined)?.indexOf(
    source.asset,
  );
  const amount = toBaseUnits(send, source.decimals);
  return async (s: Session, f: Flow, index: number) => {
    base(s, f);
    f.srcChainIndex = Math.max(chainIndex, 0);
    f.srcAssetIndex = Math.max(assetIndex ?? 0, 0);
    s.quoted = {
      ...QUOTED,
      send,
      symbol: source.asset,
      sourceAsset: source.asset,
      sourceChain: source.chain,
    };
    const r = await previewRequest(s, { sourceId, index });
    await core(r, 0, {
      phase: "failed",
      sourceId,
      failure: {
        kind: "refunded",
        step: "swap",
        message: "The deposit didn't go through. It is being returned to your recovery address.",
        recoverable: false,
      },
      refund: { amount, txRef: "7f1c9b2e4d6a8c0f1e3b5d7a9c2e4f6081a3c5e7" },
    } as PaymentState);
    // The panel reads the refund key off the request's world.
    s.mock = await createMockCoinageSession({
      recipient: DEPOSIT.address,
      amount: BigInt(amount),
      sourceId,
    });
  };
}

/** Every UI source, with a plausible refund amount in its own precision. */
const REFUND_PREVIEWS: readonly [SourceId, string][] = [
  ["usdt-tron", "5.02"],
  ["trx-tron", "15.4"],
  ["btc", "0.00004545"],
  ["eth", "0.0012"],
  ["usdc-eth", "5.02"],
  ["usdt-eth", "5.02"],
  ["sol-solana", "0.025"],
  ["usdc-solana", "5.02"],
  ["usdt-solana", "5.02"],
];

/**
 * Installs a mock world for p5, the refunded Bitcoin top-up in the preview history.
 *
 * Off-host `recoverRefundKeyFor` returns null — there is no entropy root to derive from — so the
 * refund guide would otherwise show its "can't be loaded here" state on every scene. The mock
 * world stands in for the derivation so the screen can be seen whole. Only a host build exercises
 * the real recovery; this proves the screen, not the key.
 */
function installPreviewRefundWorld(session: Session) {
  void createMockCoinageSession({
    recipient: DEPOSIT.address,
    amount: BigInt(toBaseUnits("0.00043", 8)),
    sourceId: "btc",
  }).then((world) => {
    session.mock = world;
  });
}

/** A top-ups scene: the shell's landing screen, with the cards it is asked to draw. */
/**
 * A list scene: the top-ups still running, which it seeds as real records for the adapters to
 * project, and the finished ones, which it supplies as rows.
 *
 * The records go in before the scene is announced, so the entry rule and the cards it decides
 * between are resolved against content that is already there.
 */
function topUpList(
  opts: Omit<PreviewTopUpScene, "topUps"> & {
    running?: readonly RunningTopUp[];
    finished?: readonly FundingTopUp[];
  } = {},
) {
  const { running, finished, ...scene } = opts;
  return async (s: Session, f: Flow, i: number) => {
    base(s, f);
    if (running !== undefined) await seedRunningTopUps(s, i, running);
    previewTopUpScene.value = { ...(finished === undefined ? {} : { topUps: finished }), ...scene };
  };
}

/** What the crypto rail's records name. Its source id is the rail's, so the coin the buyer sent
 *  is said separately — exactly as a real record says it. */
const SENT_BITCOIN = { chain: "Bitcoin", asset: "BTC" };

const CRYPTO_PACKAGE: PreviewStage = { kind: "package", route: "crypto" };
const CRYPTO_JOURNEY: PreviewStage = { kind: "journey", route: "crypto" };
const CARD_JOURNEY: PreviewStage = { kind: "journey", route: "card" };

/**
 * The scene families, in the order they are matched: the first prefix a scene's name starts with
 * wins. The names are already a taxonomy — "crypto / deposit: waiting" belongs to the package that
 * owns the deposit, "crypto / claim: consent" to the journey that owns the claim — so the stage is
 * read off them rather than repeated on all fifty-odd scenes.
 */
const STAGE_BY_PREFIX: readonly (readonly [string, PreviewStage])[] = [
  ["list / ", { kind: "shell" }],
  // The crypto package owns everything up to and including the deposit.
  ["crypto / network", CRYPTO_PACKAGE],
  ["crypto / token", CRYPTO_PACKAGE],
  ["crypto / deposit", CRYPTO_PACKAGE],
  ["crypto / resume spinner", CRYPTO_PACKAGE],
  ["crypto / ", CRYPTO_JOURNEY],
  ["card / ", CARD_JOURNEY],
];

function stageFor(scene: Scene): PreviewStage {
  if (scene.stage) return scene.stage;
  const match = STAGE_BY_PREFIX.find(([prefix]) => scene.name.startsWith(prefix));
  return match?.[1] ?? { kind: "shell" };
}

/** The store's own message for a payment the adapter no longer knows. */
const MELD_GONE_MESSAGE =
  "We can no longer find this payment. Do not pay again. Contact support with your reference.";

const CARD_PAYMENT_FAILED: PaymentState = {
  phase: "failed",
  sourceId: "meld-card",
  failure: {
    kind: "deposit-rejected",
    step: "deposit",
    message: "Top-up didn't go through. No money was taken.",
    recoverable: true,
  },
} as PaymentState;

const CARD_DECLINED: PaymentState = {
  phase: "failed",
  sourceId: "meld-card",
  failure: {
    kind: "deposit-rejected",
    step: "deposit",
    message: "Your bank declined the payment. Check your card details or try another card.",
    recoverable: true,
  },
} as PaymentState;

const CARD_REFUNDED: PaymentState = {
  phase: "failed",
  sourceId: "meld-card",
  failure: {
    kind: "deposit-rejected",
    step: "deposit",
    message: "Your top-up didn't go through. Your 52.06 USD has been returned to your card.",
    recoverable: true,
  },
} as PaymentState;

// Scenes start at the first screen a package owns.
export const SCENES: Scene[] = [
  {
    // The shell's landing screen: one crypto top-up still waiting on its transfer. Seeded as a
    // record, so the card is the chainflip adapter's own row and opening it opens the request.
    name: "list / top-up: waiting",
    apply: topUpList({
      running: [
        { sourceId: CRYPTO_SOURCE_ID, amount: "50", stage: "waiting", display: SENT_BITCOIN },
      ],
    }),
  },
  {
    name: "list / top-up: converting",
    apply: topUpList({
      running: [
        { sourceId: CRYPTO_SOURCE_ID, amount: "50", stage: "converting", display: SENT_BITCOIN },
      ],
    }),
  },
  {
    name: "list / top-up: adding",
    apply: topUpList({
      running: [
        { sourceId: CRYPTO_SOURCE_ID, amount: "50", stage: "adding", display: SENT_BITCOIN },
      ],
    }),
  },
  {
    // The amber line: the card rail has the payment but its crypto delivery is retrying, which is
    // never terminal. The words stay the rail's own stage — the amber is the whole difference.
    name: "list / top-up: retrying",
    apply: topUpList({
      running: [{ sourceId: "meld-card", amount: "50", stage: "confirming", delayed: true }],
    }),
  },
  {
    // The bank rail's own slow confirm, on a route whose ingress runs for days.
    name: "list / top-up: taking longer",
    apply: topUpList({
      running: [{ sourceId: "meld-bank", amount: "50", stage: "confirming", delayed: true }],
    }),
  },
  {
    // The settled card rides at the end of the running ones.
    name: "list / top-up: settled",
    apply: topUpList({
      running: [
        { sourceId: CRYPTO_SOURCE_ID, amount: "50", stage: "waiting", display: SENT_BITCOIN },
      ],
      finished: [previewTopUp("p2", "card", "settled", "Added to your balance")],
    }),
  },
  {
    // The scene asks for the top-ups screen with nothing running, which is what closing a journey
    // after your last top-up landed used to do. The entry rule now sends it to the amount screen
    // with the clock instead, so this scene is the review comment's fix rather than the bug: a
    // list titled "Top-up in progress" must never open with no top-up in progress.
    name: "list / top-up: all settled",
    apply: topUpList({
      finished: [previewTopUp("p2", "card", "settled", "Added to your balance")],
    }),
  },
  {
    // Past the collapse: three cards and the Show more pill.
    name: "list / top-ups: show more",
    apply: topUpList({
      running: [
        { sourceId: "meld-bank", amount: "50", stage: "waiting" },
        {
          sourceId: CRYPTO_SOURCE_ID,
          amount: "120",
          stage: "converting",
          display: SENT_BITCOIN,
        },
        { sourceId: CRYPTO_SOURCE_ID, amount: "25", stage: "adding", display: SENT_BITCOIN },
        { sourceId: "meld-card", amount: "200", stage: "confirming", delayed: true },
      ],
      finished: [
        previewTopUp("p5", "crypto", "settled", "Added to your balance", { amount: "80" }),
      ],
    }),
  },
  {
    // The screen's own shapes while the top-ups are still being read.
    name: "list / top-ups: loading",
    apply: topUpList({
      running: [
        { sourceId: CRYPTO_SOURCE_ID, amount: "50", stage: "waiting", display: SENT_BITCOIN },
      ],
      skeleton: true,
    }),
  },
  {
    // Behind the clock: finished top-ups, credited and failed. The refunded Bitcoin card opens the
    // recovery guide, so its world is installed here too — tapping through is how the screen is
    // actually reached.
    name: "list / history",
    apply: async (s, f, i) => {
      await topUpList({ finished: previewTopUpHistory(), entry: "history" })(s, f, i);
      installPreviewRefundWorld(s);
    },
  },
  {
    // Nothing has ever been topped up.
    name: "list / history: empty",
    apply: topUpList({ finished: [], entry: "history" }),
  },
  {
    name: "list / history: loading",
    apply: topUpList({ finished: [], entry: "history", skeleton: true }),
  },
  {
    // A top-up that would not open, with the list long enough to scroll. The review comment on
    // `FundingHistoryScreen` is about where the line lands: it is the last thing in the scroller,
    // so the buyer who just tapped a card at the top never sees it.
    name: "list / history: error",
    apply: topUpList({
      finished: previewTopUpHistory(),
      entry: "history",
      error: "Crypto status couldn't be opened. Try again.",
    }),
  },
  {
    name: "crypto / network",
    apply: (s, f) => {
      selection(s, f);
      f.step = "network";
    },
  },
  {
    name: "crypto / network: loading",
    apply: (s, f) => {
      selection(s, f);
      useOffersStore().floors = null; // still learning: the skeleton rows
      f.step = "network";
    },
  },
  {
    name: "crypto / network: too small",
    apply: (s, f) => {
      selection(s, f);
      s.setAmount("5");
      s.quoted = { ...QUOTED }; // 0.29 DOT: under every floor
      f.step = "network";
    },
  },
  {
    name: "crypto / network: paused",
    apply: (s, f) => {
      selection(s, f);
      const offers = useOffersStore();
      offers.floors = new Map(
        [...FLOORS.keys()].map((id) => [
          id,
          { kind: "unavailable", reason: "Quoting is currently unavailable due to maintenance" },
        ]),
      );
      // The demo build's carry-on fallback would swallow the paused state this scene shows.
      offers.demoFallback = false;
      f.step = "network";
    },
  },
  {
    // A build with no channel rail: every route listed, none pickable.
    name: "crypto / network: not available yet",
    apply: (s, f) => {
      selection(s, f);
      useOffersStore().railEnabled = false;
      f.step = "network";
    },
  },
  {
    name: "crypto / token",
    apply: (s, f) => {
      selection(s, f);
      f.step = "token";
    },
  },
  {
    // The deposit screen's skeleton shapes while the request is being opened.
    name: "crypto / deposit: opening",
    apply: (s, f) => {
      base(s, f);
      s.resuming = true;
    },
  },
  {
    name: "crypto / deposit: waiting",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, awaitingDeposit());
    },
  },
  {
    // The full-screen confirmation over an open deposit.
    name: "crypto / deposit: cancel confirm",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, awaitingDeposit());
      f.confirmingCancel = true;
    },
  },
  {
    name: "crypto / deposit: faucet sent",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, awaitingDeposit());
      s.faucetState = "sent";
    },
  },
  {
    name: "crypto / deposit: faucet failed",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, awaitingDeposit());
      useRequestsStore().setTransientError({
        message: "faucet transfer failed on-chain (is the faucet funded on Asset Hub?)",
        at: Date.now(),
        source: "faucet",
      });
    },
  },
  {
    // The channel deadline as a ticking countdown row.
    name: "crypto / deposit: expiring",
    apply: async (s, f, i) => {
      base(s, f);
      const expiresAt = Date.now() + 4 * 60_000 + 59_000;
      const r = await previewRequest(s, { sourceId: "btc", index: i, deposit: { expiresAt } });
      await core(r, 0, awaitingDeposit(expiresAt));
    },
  },
  {
    // The window closed with nothing sent: the clock expires the request.
    name: "crypto / deposit: expired",
    apply: async (s, f, i) => {
      base(s, f);
      const expiresAt = Date.now() - 60_000;
      const r = await previewRequest(s, { sourceId: "btc", index: i, deposit: { expiresAt } });
      await core(r, 0, awaitingDeposit(expiresAt));
      await r.observe({ source: "clock", at: Date.now() });
    },
  },
  {
    name: "crypto / convert: receiving",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, swapping("receiving"));
    },
  },
  {
    // The chain is slow to confirm: amber Payment step, its own ribbon line, never terminal.
    name: "crypto / convert: delayed",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, swapping("receiving"));
      await r.observe(railDelayed(r, 1, "chainflip"));
    },
  },
  {
    // The design's card summary: the region row above the quote's own terms. Cycle to it from
    // inside the card package — the deck stages what a route shows, not which route is mounted.
    name: "card / summary: payment country",
    apply: (s, f) => {
      cardSummary(s, f);
    },
  },
  {
    // The picker over that summary, with one region of each kind: pickable, under its minimum
    // (Guernsey at £40 against a £12.50 purchase), and not routed at all.
    name: "card / picker: choose payment country",
    apply: (s, f) => {
      cardSummary(s, f);
      f.previewDrillIn = "currency";
    },
  },
  {
    // The design's card journey at the Payment step: Fees and Total quoted in fiat.
    name: "card / journey: payment",
    apply: async (s, f, i) => {
      await cardPayment(s, f, i);
    },
  },
  {
    name: "card / journey: converting",
    apply: async (s, f, i) => {
      // The provider delivered the DOT and the worker started the swap.
      const r = await cardPayment(s, f, i);
      await core(r, 1, swapping("complete", "meld-card"));
      await r.observe(worker(r, 2, "swap"));
    },
  },
  {
    // The provider's crypto delivery is stuck and retrying (TRANSACTION_CRYPTO_FAILED): amber
    // current step, delay notice in the ribbon, nothing terminal.
    name: "card / journey: delayed",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await r.observe(railDelayed(r, 1, "meld"));
    },
  },
  {
    // After "Try again" on a failed payment: the new attempt in flight on the Payment step, amber
    // like the delayed state, the retry line in the ribbon, no button.
    // FUTURE: our retry flow does not exist yet, so the app cannot reach this state.
    name: "card / journey: retrying (future)",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await r.observe(railDelayed(r, 1, "meld"));
      useRequestsStore().fundingNotice = "Hang tight, we're retrying your payment";
    },
  },
  {
    // Meld FAILED: terminal, nothing was charged. The design's inline "Try again" is our own
    // retry system (re-request the payment); the button is shown here, its action lands later.
    name: "card / journey: payment failed",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await core(r, 1, CARD_PAYMENT_FAILED);
    },
  },
  {
    // Meld DECLINED: the bank refused the card; the message is the `declined` mapping's. The
    // design labels the button "Try another card" and routes it to card entry; the action lands
    // later, and the adapter emitting `declined` is unconfirmed (today it flattens to `failed`).
    name: "card / journey: declined",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await core(r, 1, CARD_DECLINED);
    },
  },
  {
    // Meld REFUNDED: terminal, the charge was captured and returned; per Meld it cannot be
    // retried, only replaced by a fresh top-up. The message is what getMeldStatus composes from
    // the adapter's reported terms. The design labels the button "Add money again" and starts a
    // new transaction; the action lands later, and the adapter emitting `refunded` is unconfirmed.
    name: "card / journey: refunded",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await core(r, 1, CARD_REFUNDED);
    },
  },
  {
    // The same refund read off the list's own record, with nothing live behind it. The receipt
    // rows must survive the request being gone: they come from the record, not the session.
    name: "card / refunded: from history",
    stage: { kind: "journey", route: "card", topUpId: "p8" },
    apply: topUpList({ finished: previewTopUpHistory(), entry: "history" }),
  },
  {
    // A record that kept neither of the provider's names — no create call captured one and no
    // quote was stored to fall back on — so the row can only name the aggregator. The
    // funding-request id was always persisted, so the reference beside it is still real.
    name: "card / refunded: provider unknown",
    stage: { kind: "journey", route: "card", topUpId: "p9" },
    apply: topUpList({ finished: previewTopUpHistory(), entry: "history" }),
  },
  {
    // An expiry read off the list's own record: the marker says "Expired", the ribbon spells out
    // that no funds arrived, and there are no money rows — nobody was charged. The card twin below
    // is the review comment's case: without the record's own word it drew the failure receipt.
    name: "crypto / expired: from history",
    stage: { kind: "journey", route: "crypto", topUpId: "p10" },
    apply: topUpList({ finished: previewTopUpHistory(), entry: "history" }),
  },
  {
    name: "card / expired: from history",
    stage: { kind: "journey", route: "card", topUpId: "p11" },
    apply: topUpList({ finished: previewTopUpHistory(), entry: "history" }),
  },
  {
    // No Start over here: the rail could not tell whether the buyer was charged, and a second
    // payment would risk charging them twice.
    name: "card / journey: unconfirmed",
    apply: async (s, f, i) => {
      cardJourney(s, f);
      // The reference is the whole point of this ending: the message asks the buyer for it.
      const r = await previewRequest(s, { sourceId: "meld-card", index: i, meld: PREVIEW_MELD });
      // The adapter's terminal 404, which the reducer ends `unobserved`: the payment was never
      // reported, so the record must not be re-opened from here.
      await r.observe({
        source: "provider",
        provider: "meld",
        at: r.at(0),
        gone: true,
        message: MELD_GONE_MESSAGE,
      });
    },
  },
  {
    // The design's card success screen: the credited amount over the fiat Fees and Total.
    name: "card / journey: success",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      // The provider delivered the payment before the leg settled.
      await core(r, 1, swapping("complete", "meld-card"));
      await core(r, 2, {
        phase: "done",
        sourceId: "meld-card",
        result: { id: "preview", sourceId: "meld-card" },
      } as PaymentState);
    },
  },
  {
    // The design's bank summary: the same region row, the transfer's own terms under it.
    name: "bank / summary: payment country",
    apply: (s, f) => {
      bankSummary(s, f);
    },
  },
  {
    // The bank picker: its rails only, but carrying the same minimums the card list does.
    name: "bank / picker: choose payment country",
    apply: (s, f) => {
      bankSummary(s, f);
      f.previewDrillIn = "currency";
    },
  },
  {
    // The journey's skeleton: the store is bringing a bank top-up back to the foreground and the
    // screen holds its own shapes until the record lands.
    name: "bank / journey: opening",
    apply: (s, f) => {
      bankJourney(s, f);
      s.resuming = true;
    },
  },
  {
    // The design's bank pending frame: the transfer is the buyer's word until the money lands, so
    // the stepper waits on "Payment" and the rows restate what to send and what to quote with it.
    name: "bank / journey: transfer sent",
    apply: async (s, f, i) => {
      await bankTransfer(s, f, i);
    },
  },
  {
    // The design's "Cancel top-up?" frame: the full-screen confirmation over the pending transfer.
    name: "bank / journey: cancel confirm",
    apply: async (s, f, i) => {
      await bankTransfer(s, f, i);
      f.confirmingCancel = true;
    },
  },
  {
    // The provider has the money and its delivery is stuck, retrying on their side. Nothing is
    // left to instruct or to call off, and the stepper goes amber rather than red.
    name: "bank / journey: delayed",
    apply: async (s, f, i) => {
      const r = await bankTransfer(s, f, i);
      await r.observe(railDelayed(r, 1, "meld"));
    },
  },
  {
    // The transfer landed: the provider delivered it and the worker has the deposit. The wait is
    // off the buyer now, so the stepper moves on and the cancel goes with it.
    name: "bank / journey: transfer arrived",
    apply: async (s, f, i) => {
      const r = await bankTransfer(s, f, i);
      await r.observe({
        source: "provider",
        provider: "meld",
        at: r.at(1),
        result: { status: "complete" },
      });
      await r.observe(worker(r, 2, "swap"));
    },
  },
  {
    // The design's bank success frame: the credit in green over its one past-tense row.
    name: "bank / journey: success",
    apply: async (s, f, i) => {
      const r = await bankTransfer(s, f, i);
      await r.observe({
        source: "provider",
        provider: "meld",
        at: r.at(1),
        result: { status: "complete" },
      });
      await core(r, 2, swapping("complete", "meld-bank"));
      await core(r, 3, {
        phase: "done",
        sourceId: "meld-bank",
        result: { id: "preview", sourceId: "meld-bank" },
      } as PaymentState);
    },
  },
  {
    // The design's bank failure frame: nothing was taken, so the rows are the handles for asking
    // about it and the way on is a fresh top-up.
    name: "bank / journey: payment failed",
    apply: async (s, f, i) => {
      await bankEnding(s, f, i, "failed", "Top-up didn't go through. No money was taken.");
    },
  },
  {
    // The bank refused the transfer. The adapter words this one for a card; the journey says what
    // it means for a transfer.
    name: "bank / journey: declined",
    apply: async (s, f, i) => {
      await bankEnding(
        s,
        f,
        i,
        "declined",
        "Your bank declined the payment. Check your card details or try another card.",
      );
    },
  },
  {
    // The rate moved between the payment and the claim: the hero corrects itself to what will
    // actually land, and the ribbon names both figures so the difference is the buyer's to check.
    name: "bank / journey: rate changed",
    apply: async (s, f, i) => {
      const r = await bankTransfer(s, f, i);
      await r.observe({
        source: "provider",
        provider: "meld",
        at: r.at(1),
        result: { status: "complete" },
      });
      // 48.2 CASH claimed against the 50 quoted, in 6-decimal base units.
      await r.observe({
        source: "core",
        at: r.at(2),
        claim: { stage: "crediting", claimed: "48200000" },
      });
    },
  },
  {
    // The money was taken and sent back. Terminal: the provider will not retry it, and a fresh
    // top-up is the only way on.
    name: "bank / journey: refunded",
    apply: async (s, f, i) => {
      await bankEnding(
        s,
        f,
        i,
        "refunded",
        "Your top-up didn't go through. Your 50.55 EUR has been returned to your card.",
      );
    },
  },
  {
    name: "crypto / convert: swapping",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, swapping("swapping"));
    },
  },
  {
    name: "crypto / convert: sending",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, swapping("sending"));
    },
  },
  {
    name: "crypto / pipeline: swap",
    apply: async (s, f, i) => {
      await pipeline(s, f, i, "swap");
    },
  },
  {
    name: "crypto / pipeline: arrival wait",
    apply: async (s, f, i) => {
      await pipeline(s, f, i, "await-arrival");
    },
  },
  {
    name: "crypto / heal: reconnecting",
    apply: async (s, f, i) => {
      await pipeline(s, f, i, "swap");
      useRequestsStore().fundingNotice = "connection lost, reconnecting…";
    },
  },
  {
    name: "crypto / claim: consent",
    apply: async (s, f, i) => {
      await claimConsent(s, f, i);
    },
  },
  {
    name: "crypto / claim: crediting",
    apply: async (s, f, i) => {
      const r = await claimConsent(s, f, i);
      await r.observe({
        source: "core",
        at: r.at(2),
        claim: { stage: "crediting", claimed: "5000000" },
      });
    },
  },
  {
    name: "crypto / claim: verifying",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await r.observe(worker(r, 0, "done", true));
      await core(r, 1, working("verifying"));
    },
  },
  {
    name: "crypto / failed: recoverable",
    apply: async (s, f, i) => {
      const r = await claimConsent(s, f, i);
      await core(r, 2, {
        phase: "failed",
        sourceId: "btc",
        failure: {
          kind: "mint",
          step: "mint",
          message: "Settled, but verification failed. Retry to re-verify the credit.",
          recoverable: true,
        },
      } as PaymentState);
    },
  },
  {
    name: "crypto / failed: refunded",
    apply: async (s, f, i) => {
      base(s, f);
      f.srcChainIndex = 3;
      f.srcAssetIndex = 1; // USDT on Tron: a token refund, with the gas note
      s.quoted = {
        ...QUOTED,
        send: "5.02",
        symbol: "USDT",
        sourceAsset: "USDT",
        sourceChain: "Tron",
      };
      const r = await previewRequest(s, { sourceId: "usdt-tron", index: i });
      await core(r, 0, {
        phase: "failed",
        sourceId: "usdt-tron",
        failure: {
          kind: "refunded",
          step: "swap",
          message: "The deposit didn't go through. It is being returned to your recovery address.",
          recoverable: false,
        },
        refund: { amount: "5020000", txRef: "7f1c9b2e4d6a8c0f1e3b5d7a9c2e4f6081a3c5e7" },
      } as PaymentState);
      // The panel reads the refund key off the request's world.
      const world = await createMockCoinageSession({
        recipient: DEPOSIT.address,
        amount: 5_000_000n,
        sourceId: "usdt-tron",
      });
      s.mock = world;
    },
  },
  {
    // The same refund read from the list's own record, with nothing live behind it: the request
    // could not be resumed, so the journey has only what history stored. This is the state the
    // review comment is about — the rows are hidden because the deposit went back, and the guide
    // behind "Refund info" is driven by the request's world, which is gone.
    name: "crypto / refunded: from history",
    stage: { kind: "journey", route: "crypto", topUpId: "p5" },
    apply: async (s, f, i) => {
      await topUpList({ finished: previewTopUpHistory(), entry: "history" })(s, f, i);
      installPreviewRefundWorld(s);
    },
  },
  // The return-funds screen opened with the key revealed, once per source: the step copy is
  // templated on the chain, its native coin, and the asset, so each reads differently.
  ...REFUND_PREVIEWS.map(([sourceId, send]) => {
    const source = SOURCE_CONFIG_BY_ID.get(sourceId)!;
    const apply = refunded(sourceId, send);
    return {
      name: `crypto / refund key: ${source.asset} on ${source.chain}`,
      apply: async (s: Session, f: Flow, index: number) => {
        await apply(s, f, index);
        s.revealRefund = true;
      },
    };
  }),
  {
    name: "crypto / success",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(r, 0, swapping("receiving"));
      await core(r, 1, {
        phase: "done",
        sourceId: "btc",
        result: { id: "preview", sourceId: "btc" },
      } as PaymentState);
    },
  },
  {
    name: "crypto / resume spinner",
    apply: (s, f) => {
      base(s, f);
      s.resuming = true;
    },
  },

  // ——— The withdrawal package's pickers, staged by `#/withdraw`. The stage carries everything —
  // the step on screen and the skeletons — and the screens read static data, so `base` only
  // clears what a neighbouring scene seeded.
  {
    name: "withdraw / network: loaded",
    stage: { kind: "withdraw-package", step: "network" },
    apply: (s, f) => base(s, f),
  },
  {
    name: "withdraw / network: skeleton",
    stage: { kind: "withdraw-package", step: "network", skeleton: true },
    apply: (s, f) => base(s, f),
  },
  {
    name: "withdraw / token: loaded",
    stage: { kind: "withdraw-package", step: "token", chain: "Ethereum" },
    apply: (s, f) => base(s, f),
  },
  {
    name: "withdraw / token: skeleton",
    stage: { kind: "withdraw-package", step: "token", chain: "Ethereum", skeleton: true },
    apply: (s, f) => base(s, f),
  },
];

/**
 * The launch scenario's two running top-ups, as records.
 *
 * Seeded into the sandbox, so `?preview=top-ups` needs no host and writes nothing durable, and
 * awaited before the shell goes interactive: the entry rule has to decide against content that is
 * already there, which is the whole point of the scenario.
 */
export async function seedLaunchPreviewTopUps(): Promise<void> {
  const requests = useRequestsStore();
  requests.enterSandbox();
  await seedRunningTopUps(useSessionStore(), 0, [
    {
      sourceId: CRYPTO_SOURCE_ID,
      amount: "50",
      stage: "waiting",
      display: SENT_BITCOIN,
      startedMinutesAgo: 4,
    },
    { sourceId: "meld-card", amount: "120", stage: "converting", startedMinutesAgo: 21 },
  ]);
}

let index = -1;

/**
 * Writes the current scene's state. Separate from `directScene` because the shell re-runs it once
 * a scene's container is up: mounting a package or leaving the journey runs that container's own
 * entry and teardown, which would otherwise land on top of the state the scene just wrote.
 */
export async function applyCurrentScene(): Promise<void> {
  const scene = SCENES[index];
  if (!scene) return;
  await scene.apply(useSessionStore(), useFlowStore(), index);
}

/** Applies the next scene; resolves once its observations have landed. */
export async function directScene(delta: 1 | -1): Promise<string> {
  // The deck's requests are fakes: they never reach the host store or the worker.
  useRequestsStore().enterSandbox();
  index = (index + delta + SCENES.length) % SCENES.length;
  const scene = SCENES[index]!;
  // The container first: the shell reads this and moves, then applies the state again on top.
  previewStage.value = stageFor(scene);
  const label = `${index + 1}/${SCENES.length} ${scene.name}`;
  console.info(`[preview] ${label}`);
  await applyCurrentScene();
  return label;
}
