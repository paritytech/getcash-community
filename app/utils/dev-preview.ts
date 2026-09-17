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
  previewTopUp,
  previewTopUpHistory,
  previewTopUpScene,
  type PreviewTopUpScene,
} from "./dev-preview-top-ups";
import type { FundingTopUp } from "../funding/top-ups";
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
  fee: "1.56",
  networkFee: "0.01",
  nativeAmount: null,
  sourceAsset: null,
  sourceChain: null,
};

/** What the record shows for each source the scenes use. A source not named here is displayed as
 *  its swap config names it. */
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
  opts: {
    sourceId: SourceId;
    index: number;
    deposit?: { expiresAt: number };
    /** What the Meld create call captured: the provider that took the payment, and the funding
     *  request's id. The record keeps both, as a real card request's does. */
    meld?: { serviceProvider: string; fundingRequestId: string };
  },
): Promise<PreviewRequest> {
  const requests = useRequestsStore();
  const { sourceId } = opts;
  const ref: RequestRef = { sourceId, tradeN: 900 + opts.index };
  if (requests.has(ref)) await requests.remove(ref);
  const now = Date.now();
  const startedAt = now - 5 * 60_000;
  const expiresAt = opts.deposit?.expiresAt ?? 0;
  const config = SOURCE_CONFIG_BY_ID.get(sourceId);
  const display =
    DISPLAY[sourceId] ??
    (config ? { chain: config.chain, asset: config.asset } : { chain: sourceId, asset: sourceId });
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
    ...(opts.meld
      ? {
          meldServiceProvider: opts.meld.serviceProvider,
          meldFundingRequestId: opts.meld.fundingRequestId,
        }
      : {}),
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
  flow.step = "amount";
  flow.confirmingCancel = false;
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

/** What the card scenes' create call captured, as the record keeps it. */
const PREVIEW_MELD = {
  serviceProvider: "Transak",
  fundingRequestId: "a1f9c3d2-4c2e-4a71-9f0b-6d5e8c2b1a03",
};

/** Baseline for the selection scenes: 100 CASH, floors already learned, source set directly. */
function selection(session: Session, flow: Flow) {
  base(session, flow);
  session.setAmount("100");
  session.quoted = { ...QUOTED, nativeAmount: 58_694_260_960n };
  const offers = useOffersStore();
  offers.floors = FLOORS;
  // The paused scene turns the demo fallback off; every other scene gets the build's own setting.
  offers.demoFallback = isDemoBuild();
  flow.srcChainIndex = 1; // Ethereum
  flow.srcAssetIndex = 0;
}

/** The card scenes' request, once the provider has seen the payment. */
async function cardPayment(s: Session, f: Flow, index: number): Promise<PreviewRequest> {
  cardJourney(s, f);
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
function topUpList(topUps: readonly FundingTopUp[], extra: Omit<PreviewTopUpScene, "topUps"> = {}) {
  return (s: Session, f: Flow) => {
    base(s, f);
    previewTopUpScene.value = { topUps, ...extra };
  };
}

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
    // The shell's landing screen: one crypto top-up still waiting on its transfer.
    name: "list / top-up: waiting",
    apply: topUpList([previewTopUp("p1", "crypto", "waiting", "Waiting for your transfer")]),
  },
  {
    name: "list / top-up: converting",
    apply: topUpList([previewTopUp("p1", "crypto", "active", "Converting to $CASH")]),
  },
  {
    name: "list / top-up: adding",
    apply: topUpList([previewTopUp("p1", "crypto", "active", "Adding to your balance")]),
  },
  {
    // The amber line: the card rail is retrying, which is never terminal.
    name: "list / top-up: retrying",
    apply: topUpList([
      previewTopUp("p1", "card", "active", "Retrying your payment…", { delayed: true }),
    ]),
  },
  {
    name: "list / top-up: taking longer",
    apply: topUpList([
      previewTopUp("p1", "bank", "active", "Taking a little longer than usual", { delayed: true }),
    ]),
  },
  {
    // The settled card rides at the end of the running ones.
    name: "list / top-up: settled",
    apply: topUpList([
      previewTopUp("p1", "crypto", "waiting", "Waiting for your transfer"),
      previewTopUp("p2", "card", "settled", "Added to your balance"),
    ]),
  },
  {
    // The scene asks for the top-ups screen with nothing running, which is what closing a journey
    // after your last top-up landed used to do. The entry rule now sends it to the amount screen
    // with the clock instead, so this scene is the review comment's fix rather than the bug: a
    // list titled "Top-up in progress" must never open with no top-up in progress.
    name: "list / top-up: all settled",
    apply: topUpList([previewTopUp("p2", "card", "settled", "Added to your balance")]),
  },
  {
    // Past the collapse: three cards and the Show more pill.
    name: "list / top-ups: show more",
    apply: topUpList([
      previewTopUp("p1", "bank", "waiting", "Waiting for your transfer"),
      previewTopUp("p2", "crypto", "active", "Converting to $CASH", { amount: "120" }),
      previewTopUp("p3", "crypto", "active", "Adding to your balance", { amount: "25" }),
      previewTopUp("p4", "card", "active", "Retrying your payment…", { delayed: true }),
      previewTopUp("p5", "crypto", "settled", "Added to your balance", { amount: "80" }),
    ]),
  },
  {
    // The screen's own shapes while the top-ups are still being read.
    name: "list / top-ups: loading",
    apply: topUpList([previewTopUp("p1", "crypto", "waiting", "Waiting for your transfer")], {
      skeleton: true,
    }),
  },
  {
    // Behind the clock: finished top-ups, credited and failed. The refunded Bitcoin card opens the
    // recovery guide, so its world is installed here too — tapping through is how the screen is
    // actually reached.
    name: "list / history",
    apply: (s, f) => {
      topUpList(previewTopUpHistory(), { entry: "history" })(s, f);
      installPreviewRefundWorld(s);
    },
  },
  {
    // Nothing has ever been topped up.
    name: "list / history: empty",
    apply: topUpList([], { entry: "history" }),
  },
  {
    name: "list / history: loading",
    apply: topUpList([], { entry: "history", skeleton: true }),
  },
  {
    // A top-up that would not open, with the list long enough to scroll. The review comment on
    // `FundingHistoryScreen` is about where the line lands: it is the last thing in the scroller,
    // so the buyer who just tapped a card at the top never sees it.
    name: "list / history: error",
    apply: topUpList(previewTopUpHistory(), {
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
    apply: topUpList(previewTopUpHistory(), { entry: "history" }),
  },
  {
    // What every buyer's existing history actually renders today: the funding-request id was
    // always persisted, so the reference is real, but no record knows which provider took the
    // payment — the row names the aggregator instead. This is the shipped state; the scene above
    // is what it becomes once the adapter surfaces the rail's own ids.
    name: "card / refunded: provider unknown",
    stage: { kind: "journey", route: "card", topUpId: "p9" },
    apply: topUpList(previewTopUpHistory(), { entry: "history" }),
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
    apply: (s, f) => {
      topUpList(previewTopUpHistory(), { entry: "history" })(s, f);
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
];

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
