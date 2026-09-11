// The state director for dev and demo builds: Ctrl+Shift+N / P cycles presentation scenes that
// write synthetic state into the stores; Ctrl+Shift+R reloads the page.

import type { PaymentState, SourceId } from "@getsome/core";
import { SOURCE_CONFIG_BY_ID, type SourceFloorResult } from "@getsome/chainflip";
import { SOURCE_CHAINS } from "~~/lib/config";
import {
  advanceFundingProgressSnapshot,
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  fundingProgressSignalForSharedStep,
} from "../funding/progress";
import { createMockCoinageSession } from "~~/lib/coinage";
import { isDemoBuild } from "./demo";
import type { useFlowStore } from "../stores/flow";
import { useOffersStore } from "../stores/offers";
import { DEPOSIT_EXPIRED_REASON, type useSessionStore } from "../stores/session";

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

function awaitingDeposit(expiresAt: number = DEPOSIT.expiresAt): PaymentState {
  return {
    phase: "awaiting-deposit",
    sourceId: "btc",
    quote: null,
    deposit: { ...DEPOSIT, expiresAt },
  } as PaymentState;
}
function swapping(swap: "receiving" | "swapping" | "sending" | "complete"): PaymentState {
  return {
    phase: "swapping",
    sourceId: "btc",
    quote: null,
    deposit: DEPOSIT,
    swap,
  } as PaymentState;
}
function working(step: "awaiting-consent" | "verifying" | "minting"): PaymentState {
  const mint = step === "minting" ? { step, attempt: 1, of: 3 } : { step };
  return { phase: "working", sourceId: "btc", deposit: DEPOSIT, mint } as PaymentState;
}

interface Scene {
  name: string;
  apply: (session: Session, flow: Flow) => void;
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

/** Baseline for every scene: 5 CASH quoted, journey-clean. */
function base(session: Session, flow: Flow) {
  session.setAmount("5");
  // The scenes model the crypto rail; a card/bank run before cycling scenes must not leak its
  // method into how the canned BTC quote is read.
  session.method = "crypto";
  session.quoted = { ...QUOTED };
  session.fundingStep = null;
  session.fundingError = null;
  session.fundingNotice = null;
  session.claimStage = null;
  session.resuming = false;
  session.meldDelayed = false;
  session.lastState = null;
  session.foregroundProgress = null;
  session.fundsSeen = false;
  session.revealRefund = false;
  session.milestones = {};
  flow.step = "amount";
  flow.confirmingCancel = false;
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

/** A rejected card payment on the journey: the rail's terminal states differ only in their copy.
 *  `fundsSeen` marks the payment as attempted, so the failed marker lands on Payment. */
function cardRejected(message: string) {
  return (s: Session, f: Flow) => {
    cardJourney(s, f);
    s.fundsSeen = true;
    s.lastState = {
      phase: "failed",
      sourceId: "meld-card",
      failure: {
        kind: "deposit-rejected",
        step: "deposit",
        message,
        recoverable: true,
      },
    } as PaymentState;
  };
}

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
  return (s: Session, f: Flow) => {
    base(s, f);
    // The deposit was paid — that is what makes it a refund — so Started reads done and the
    // failed marker lands on Payment, as the design draws it.
    s.fundsSeen = true;
    f.srcChainIndex = Math.max(chainIndex, 0);
    f.srcAssetIndex = Math.max(assetIndex ?? 0, 0);
    s.quoted = {
      ...QUOTED,
      send,
      symbol: source.asset,
      sourceAsset: source.asset,
      sourceChain: source.chain,
    };
    s.lastState = {
      phase: "failed",
      sourceId,
      failure: {
        kind: "refunded",
        step: "swap",
        message: "The deposit didn't go through. It is being returned to your recovery address.",
        recoverable: false,
      },
      refund: {
        amount: toBaseUnits(send, source.decimals),
        txRef: "7f1c9b2e4d6a8c0f1e3b5d7a9c2e4f6081a3c5e7",
      },
    } as PaymentState;
    void createMockCoinageSession({
      recipient: DEPOSIT.address,
      amount: BigInt(toBaseUnits(send, source.decimals)),
      sourceId,
    }).then((world) => {
      s.mock = world;
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
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
    },
  },
  {
    // The full-screen confirmation over an open deposit.
    name: "crypto / deposit: cancel confirm",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      f.confirmingCancel = true;
    },
  },
  {
    // The channel deadline as a ticking countdown row.
    name: "crypto / deposit: expiring",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit(Date.now() + 4 * 60_000 + 59_000);
    },
  },
  {
    // The window closed with nothing sent: failed progress and the expiry reason.
    name: "crypto / deposit: expired",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit(Date.now() - 60_000);
      s.fundingError = DEPOSIT_EXPIRED_REASON;
    },
  },
  {
    name: "crypto / convert: receiving",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("receiving");
    },
  },
  {
    // The chain is slow to confirm: amber Payment step, its own ribbon line, never terminal.
    name: "crypto / convert: delayed",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("receiving");
      s.meldDelayed = true;
    },
  },
  {
    // The design's card journey at the Payment step: Fees and Total quoted in fiat.
    name: "card / journey: payment",
    apply: (s, f) => {
      cardJourney(s, f);
      s.lastState = swapping("receiving");
    },
  },
  {
    name: "card / journey: converting",
    apply: (s, f) => {
      cardJourney(s, f);
      s.lastState = swapping("swapping");
    },
  },
  {
    // The provider's crypto delivery is stuck and retrying (TRANSACTION_CRYPTO_FAILED): amber
    // current step, delay notice in the ribbon, nothing terminal.
    name: "card / journey: delayed",
    apply: (s, f) => {
      cardJourney(s, f);
      s.lastState = swapping("receiving");
      s.meldDelayed = true;
    },
  },
  {
    // After "Try again" on a failed payment: the new attempt in flight on the Payment step, amber
    // like the delayed state, the retry line in the ribbon, no button.
    // FUTURE: our retry flow does not exist yet, so the app cannot reach this state.
    name: "card / journey: retrying (future)",
    apply: (s, f) => {
      cardJourney(s, f);
      s.lastState = swapping("receiving");
      s.meldDelayed = true;
      s.fundingNotice = "Hang tight, we're retrying your payment";
    },
  },
  {
    // Meld FAILED: terminal, nothing was charged. The design's inline "Try again" is our own
    // retry system (re-request the payment); the button is shown here, its action lands later.
    name: "card / journey: payment failed",
    apply: cardRejected("Top-up didn't go through. No money was taken."),
  },
  {
    // Meld DECLINED: the bank refused the card; the message is the `declined` mapping's. The
    // design labels the button "Try another card" and routes it to card entry; the action lands
    // later, and the adapter emitting `declined` is unconfirmed (today it flattens to `failed`).
    name: "card / journey: declined",
    apply: cardRejected(
      "Your bank declined the payment. Check your card details or try another card.",
    ),
  },
  {
    // Meld REFUNDED: terminal, the charge was captured and returned; per Meld it cannot be
    // retried, only replaced by a fresh top-up. The message is what getMeldStatus composes from
    // the adapter's reported terms. The design labels the button "Add money again" and starts a
    // new transaction; the action lands later, and the adapter emitting `refunded` is unconfirmed.
    name: "card / journey: refunded",
    apply: cardRejected(
      "Your top-up didn't go through. Your 52.06 USD has been returned to your card.",
    ),
  },
  {
    // The design's card success screen: the credited amount over the fiat Fees and Total.
    name: "card / journey: success",
    apply: (s, f) => {
      cardJourney(s, f);
      s.lastState = {
        phase: "done",
        sourceId: "meld-card",
        result: { id: "preview", sourceId: "meld-card" },
      } as PaymentState;
    },
  },
  {
    name: "crypto / convert: swapping",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("swapping");
    },
  },
  {
    name: "crypto / convert: sending",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("sending");
    },
  },
  {
    name: "crypto / pipeline: swap",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "swap";
    },
  },
  {
    name: "crypto / pipeline: transfer",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "xcm";
    },
  },
  {
    name: "crypto / pipeline: arrival wait",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "await-arrival";
    },
  },
  {
    name: "crypto / heal: reconnecting",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "swap";
      s.fundingNotice = "connection lost, reconnecting…";
    },
  },
  {
    name: "crypto / claim: consent",
    apply: (s, f) => {
      base(s, f);
      s.lastState = working("awaiting-consent");
    },
  },
  {
    name: "crypto / claim: crediting",
    apply: (s, f) => {
      base(s, f);
      s.lastState = working("awaiting-consent");
      s.claimStage = "crediting";
    },
  },
  {
    name: "crypto / claim: verifying",
    apply: (s, f) => {
      base(s, f);
      s.lastState = working("verifying");
    },
  },
  {
    name: "crypto / failed: recoverable",
    apply: (s, f) => {
      base(s, f);
      s.lastState = {
        phase: "failed",
        sourceId: "btc",
        failure: {
          kind: "mint",
          step: "mint",
          message: "Settled, but verification failed. Retry to re-verify the credit.",
          recoverable: true,
        },
      } as PaymentState;
    },
  },
  {
    name: "crypto / failed: refunded",
    apply: refunded("usdt-tron", "5.02"),
  },
  // The return-funds screen opened with the key revealed, once per source: the step copy is
  // templated on the chain, its native coin, and the asset, so each reads differently.
  ...REFUND_PREVIEWS.map(([sourceId, send]) => {
    const source = SOURCE_CONFIG_BY_ID.get(sourceId)!;
    const apply = refunded(sourceId, send);
    return {
      name: `crypto / refund key: ${source.asset} on ${source.chain}`,
      apply: (s: Session, f: Flow) => {
        apply(s, f);
        s.revealRefund = true;
      },
    };
  }),
  {
    name: "crypto / success",
    apply: (s, f) => {
      base(s, f);
      s.lastState = {
        phase: "done",
        sourceId: "btc",
        result: { id: "preview", sourceId: "btc" },
      } as PaymentState;
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

function applyProgress(session: Session) {
  const state = session.lastState;
  if (!state) return;
  const now = Date.now();
  const startedAt = now - 5 * 60_000;
  const profile = chainflipProgressProvider.createProfile();
  let snapshot = createFundingProgressSnapshot(profile, {
    preDetectionEstimateText: "≈10 min after your transfer",
  });
  const advance = (signal: ReturnType<typeof fundingProgressSignalForSharedStep>) => {
    snapshot = advanceFundingProgressSnapshot(snapshot, { ...signal, at: now - 128_000 });
  };
  const paymentSignal = fundingProgressSignalForPaymentState(chainflipProgressProvider, state);

  if (state.phase === "failed" && state.failure.kind === "mint") {
    advance(fundingProgressSignalForSharedStep("done"));
  } else if (state.phase === "failed" && session.fundsSeen) {
    // The payment was seen before it failed: the marker lands on Payment, with Started complete.
    const seen = fundingProgressSignalForPaymentState(
      chainflipProgressProvider,
      swapping("receiving"),
    );
    if (seen) advance(seen);
  } else if (paymentSignal && paymentSignal.observation.kind !== "failed") {
    advance(paymentSignal);
  }
  if (session.fundingStep) advance(fundingProgressSignalForSharedStep(session.fundingStep));
  if (paymentSignal?.observation.kind === "failed") advance(paymentSignal);
  // The deadline passed with no deposit seen: the store fails the top-up at that moment.
  const expiresAt = state.phase === "awaiting-deposit" ? (state.deposit.expiresAt ?? 0) : 0;
  if (expiresAt > 0 && expiresAt <= now && !session.fundsSeen) {
    advance({ observation: { kind: "failed" } });
  }

  session.foregroundProgress = { startedAt, snapshot };
}

export function directScene(session: Session, flow: Flow, delta: 1 | -1): string {
  index = (index + delta + SCENES.length) % SCENES.length;
  const scene = SCENES[index]!;
  scene.apply(session, flow);
  applyProgress(session);
  // The journey's timestamps, staggered three minutes apart from a fixed evening.
  const T0 = Date.parse("2025-05-06T17:53:00");
  const times = { ...session.milestones };
  for (let n = 1; n <= session.journeyDone; n++) times[n] ??= T0 + (n - 1) * 3 * 60_000;
  session.milestones = times;
  const label = `${index + 1}/${SCENES.length} ${scene.name}`;
  console.info(`[preview] ${label}`);
  return label;
}
