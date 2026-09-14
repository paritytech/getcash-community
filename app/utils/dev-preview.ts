// The state director for dev and demo builds: Ctrl+Shift+N / P cycles presentation scenes that
// drive the requests store with the observations a real purchase would produce; Ctrl+Shift+R
// reloads the page.

import type { PaymentState, SourceId } from "@getsome/core";
import type { SourceFloorResult } from "@getsome/chainflip";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  progressProviderForSource,
} from "../funding/progress";
import {
  DEFAULT_DEPOSIT_WINDOW_MS,
  railProviderOf,
  routeOf,
  type Observation,
  type RequestRecord,
} from "../funding/requests/model";
import { createMockCoinageSession } from "~~/lib/coinage";
import type { useFlowStore } from "../stores/flow";
import { useOffersStore } from "../stores/offers";
import { useRequestsStore } from "../stores/requests";
import type { useSessionStore } from "../stores/session";
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
  /** `index` is the scene's position in `SCENES`; it keys the scene's synthetic request. */
  apply: (session: Session, flow: Flow, index: number) => void | Promise<void>;
}

/** The canned card quote for 50 CASH: the figures the Meld design frames show. */
const QUOTED_CARD = {
  send: "52.06",
  symbol: "USD",
  fee: "1.56",
  networkFee: "0.01",
  nativeAmount: null,
  sourceAsset: null,
  sourceChain: null,
};

/** What the record shows for each source the scenes use. */
const DISPLAY: Partial<Record<SourceId, { chain: string; asset: string }>> = {
  btc: { chain: "Bitcoin", asset: "BTC" },
  "usdt-tron": { chain: "Tron", asset: "USDT" },
  "meld-card": { chain: "Meld", asset: "Card" },
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
  opts: { sourceId: SourceId; index: number; deposit?: { expiresAt: number } },
): Promise<PreviewRequest> {
  const requests = useRequestsStore();
  const { sourceId } = opts;
  const ref: RequestRef = { sourceId, tradeN: 900 + opts.index };
  if (requests.has(ref)) await requests.remove(ref);
  const now = Date.now();
  const startedAt = now - 5 * 60_000;
  const expiresAt = opts.deposit?.expiresAt ?? 0;
  const display = DISPLAY[sourceId] ?? { chain: sourceId, asset: sourceId };
  // As `persistActiveFlow` writes it: the initial snapshot moved by core's first state.
  const provider = progressProviderForSource(sourceId);
  const initial = createFundingProgressSnapshot(provider.createProfile(), {
    preDetectionEstimateText:
      sourceId === "meld-card" ? "≈ minutes after you pay" : "≈10 min after your transfer",
  });
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
    amountHuman: session.amountHuman,
    ...display,
    startedAt,
    depositAddress: DEPOSIT.address,
    progress,
    tradeN: ref.tradeN,
    sourceId,
    route: routeOf(sourceId),
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
  requests.setForeground(ref);
  return {
    ref,
    at: (step) => now - 128_000 + step * 1_000,
    observe: (observation) => requests.observe(ref, observation),
  };
}

/** Core's state as the request's own observation; the deposit screen still reads the raw echo. */
async function core(session: Session, request: PreviewRequest, step: number, state: PaymentState) {
  await request.observe({ source: "core", at: request.at(step), state });
  session.lastState = state;
}

/** The Meld poll's report that the provider's crypto delivery is stuck and retrying. */
function meldDelayed(request: PreviewRequest, step: number): Observation {
  return {
    source: "provider",
    provider: "meld",
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

/** Baseline for every scene: 5 CASH quoted, journey-clean, nothing on screen. */
function base(session: Session, flow: Flow) {
  session.setAmount("5");
  // The scenes model the crypto rail; a card/bank run before cycling scenes must not leak its
  // method into how the canned BTC quote is read.
  session.method = "crypto";
  session.quoted = { ...QUOTED };
  session.resuming = false;
  session.lastState = null;
  useRequestsStore().fundingNotice = null;
  useRequestsStore().setTransientError(null);
  useRequestsStore().leave();
  flow.step = "amount";
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

/** Baseline for the selection scenes: 100 CASH, floors already learned, source set directly. */
function selection(session: Session, flow: Flow) {
  base(session, flow);
  session.setAmount("100");
  session.quoted = { ...QUOTED, nativeAmount: 58_694_260_960n };
  useOffersStore().floors = FLOORS;
  flow.srcChainIndex = 1; // Ethereum
  flow.srcAssetIndex = 0;
}

/** The card scenes' request, once the provider has seen the payment. */
async function cardPayment(s: Session, f: Flow, index: number): Promise<PreviewRequest> {
  cardJourney(s, f);
  const r = await previewRequest(s, { sourceId: "meld-card", index });
  await core(s, r, 0, swapping("receiving", "meld-card"));
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
  await core(s, r, 1, working("awaiting-consent"));
  return r;
}

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
    name: "crypto / network",
    apply: (s, f) => {
      selection(s, f);
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
      useOffersStore().floors = new Map(
        [...FLOORS.keys()].map((id) => [
          id,
          { kind: "unavailable", reason: "Quoting is currently unavailable due to maintenance" },
        ]),
      );
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
    name: "crypto / deposit: waiting",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, awaitingDeposit());
    },
  },
  {
    name: "crypto / deposit: faucet sent",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, awaitingDeposit());
      s.faucetState = "sent";
    },
  },
  {
    name: "crypto / deposit: faucet failed",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, awaitingDeposit());
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
      await core(s, r, 0, awaitingDeposit(expiresAt));
    },
  },
  {
    // The window closed with nothing sent: the clock expires the request.
    name: "crypto / deposit: expired",
    apply: async (s, f, i) => {
      base(s, f);
      const expiresAt = Date.now() - 60_000;
      const r = await previewRequest(s, { sourceId: "btc", index: i, deposit: { expiresAt } });
      await core(s, r, 0, awaitingDeposit(expiresAt));
      await r.observe({ source: "clock", at: Date.now() });
    },
  },
  {
    name: "crypto / convert: receiving",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, swapping("receiving"));
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
      await core(s, r, 1, swapping("complete", "meld-card"));
      await r.observe(worker(r, 2, "swap"));
    },
  },
  {
    // The provider's crypto delivery is stuck and retrying (TRANSACTION_CRYPTO_FAILED): amber
    // current step, delay notice in the ribbon, nothing terminal.
    name: "card / journey: delayed",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await r.observe(meldDelayed(r, 1));
    },
  },
  {
    // After "Try again" on a failed payment: the new attempt in flight on the Payment step, amber
    // like the delayed state, the retry line in the ribbon, no button.
    // FUTURE: our retry flow does not exist yet, so the app cannot reach this state.
    name: "card / journey: retrying (future)",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await r.observe(meldDelayed(r, 1));
      useRequestsStore().fundingNotice = "Hang tight, we're retrying your payment";
    },
  },
  {
    // Meld FAILED: terminal, nothing was charged. The design's inline "Try again" is our own
    // retry system (re-request the payment); the button is shown here, its action lands later.
    name: "card / journey: payment failed",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await core(s, r, 1, CARD_PAYMENT_FAILED);
    },
  },
  {
    // Meld DECLINED: the bank refused the card; the message is the `declined` mapping's. The
    // design labels the button "Try another card" and routes it to card entry; the action lands
    // later, and the adapter emitting `declined` is unconfirmed (today it flattens to `failed`).
    name: "card / journey: declined",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      await core(s, r, 1, CARD_DECLINED);
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
      await core(s, r, 1, CARD_REFUNDED);
    },
  },
  {
    // The design's card success screen: the credited amount over the fiat Fees and Total.
    name: "card / journey: success",
    apply: async (s, f, i) => {
      const r = await cardPayment(s, f, i);
      // The provider delivered the payment before the leg settled.
      await core(s, r, 1, swapping("complete", "meld-card"));
      await core(s, r, 2, {
        phase: "done",
        sourceId: "meld-card",
        result: { id: "preview", sourceId: "meld-card" },
      } as PaymentState);
    },
  },
  {
    name: "crypto / convert: swapping",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, swapping("swapping"));
    },
  },
  {
    name: "crypto / convert: sending",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, swapping("sending"));
    },
  },
  {
    name: "crypto / pipeline: swap",
    apply: async (s, f, i) => {
      await pipeline(s, f, i, "swap");
    },
  },
  {
    name: "crypto / pipeline: transfer",
    apply: async (s, f, i) => {
      await pipeline(s, f, i, "xcm");
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
      await core(s, r, 1, working("verifying"));
    },
  },
  {
    name: "crypto / failed: recoverable",
    apply: async (s, f, i) => {
      const r = await claimConsent(s, f, i);
      await core(s, r, 2, {
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
      await core(s, r, 0, {
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
    name: "crypto / success",
    apply: async (s, f, i) => {
      base(s, f);
      const r = await previewRequest(s, { sourceId: "btc", index: i });
      await core(s, r, 0, swapping("receiving"));
      await core(s, r, 1, {
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
];

let index = -1;

/** Applies the next scene; resolves once its observations have landed. */
export async function directScene(session: Session, flow: Flow, delta: 1 | -1): Promise<string> {
  index = (index + delta + SCENES.length) % SCENES.length;
  const scene = SCENES[index]!;
  const label = `${index + 1}/${SCENES.length} ${scene.name}`;
  console.info(`[preview] ${label}`);
  await scene.apply(session, flow, index);
  return label;
}
