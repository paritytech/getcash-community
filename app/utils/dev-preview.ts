// The state director for dev and demo builds: Ctrl+Shift+N / P cycles presentation scenes that
// write synthetic state into the stores; Ctrl+Shift+R reloads the page.

import type { PaymentState, SourceId } from "@getsome/core";
import type { SourceFloorResult } from "@getsome/chainflip";
import {
  advanceFundingProgressSnapshot,
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  fundingProgressSignalForPaymentState,
  fundingProgressSignalForSharedStep,
} from "../funding/progress";
import { createMockCoinageSession } from "~~/lib/coinage";
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

/** Baseline for every scene: 5 CASH quoted, journey-clean. */
function base(session: Session, flow: Flow) {
  session.setAmount("5");
  session.quoted = { ...QUOTED };
  session.fundingStep = null;
  session.fundingError = null;
  session.fundingNotice = null;
  session.claimStage = null;
  session.resuming = false;
  session.lastState = null;
  session.foregroundProgress = null;
  session.fundsSeen = false;
  session.milestones = {};
  flow.step = "amount";
  // Bitcoin, matching the canned quote.
  flow.srcChainIndex = 0;
  flow.srcAssetIndex = 0;
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

// Scenes start at the first screen a package owns.
export const SCENES: Scene[] = [
  {
    name: "network",
    apply: (s, f) => {
      selection(s, f);
      f.step = "network";
    },
  },
  {
    name: "network: too small",
    apply: (s, f) => {
      selection(s, f);
      s.setAmount("5");
      s.quoted = { ...QUOTED }; // 0.29 DOT: under every floor
      f.step = "network";
    },
  },
  {
    name: "network: paused",
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
    name: "token",
    apply: (s, f) => {
      selection(s, f);
      f.step = "token";
    },
  },
  {
    name: "deposit: waiting",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
    },
  },
  {
    name: "deposit: faucet sent",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.faucetState = "sent";
    },
  },
  {
    name: "deposit: faucet failed",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingError = "faucet transfer failed on-chain (is the faucet funded on Asset Hub?)";
    },
  },
  {
    // The channel deadline as a ticking countdown row.
    name: "deposit: expiring",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit(Date.now() + 4 * 60_000 + 59_000);
    },
  },
  {
    // The window closed with nothing sent: failed progress and the expiry reason.
    name: "deposit: expired",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit(Date.now() - 60_000);
      s.fundingError = DEPOSIT_EXPIRED_REASON;
    },
  },
  {
    name: "convert: receiving",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("receiving");
    },
  },
  {
    name: "convert: swapping",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("swapping");
    },
  },
  {
    name: "convert: sending",
    apply: (s, f) => {
      base(s, f);
      s.lastState = swapping("sending");
    },
  },
  {
    name: "pipeline: swap",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "swap";
    },
  },
  {
    name: "pipeline: transfer",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "xcm";
    },
  },
  {
    name: "pipeline: arrival wait",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "await-arrival";
    },
  },
  {
    name: "heal: reconnecting",
    apply: (s, f) => {
      base(s, f);
      s.lastState = awaitingDeposit();
      s.fundingStep = "swap";
      s.fundingNotice = "connection lost, reconnecting…";
    },
  },
  {
    name: "claim: consent",
    apply: (s, f) => {
      base(s, f);
      s.lastState = working("awaiting-consent");
    },
  },
  {
    name: "claim: crediting",
    apply: (s, f) => {
      base(s, f);
      s.lastState = working("awaiting-consent");
      s.claimStage = "crediting";
    },
  },
  {
    name: "claim: verifying",
    apply: (s, f) => {
      base(s, f);
      s.lastState = working("verifying");
    },
  },
  {
    name: "failed: recoverable",
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
    name: "failed: refunded",
    apply: (s, f) => {
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
      s.lastState = {
        phase: "failed",
        sourceId: "usdt-tron",
        failure: {
          kind: "refunded",
          step: "swap",
          message: "The deposit didn't go through. It is being returned to your recovery address.",
          recoverable: false,
        },
        refund: { amount: "5020000", txRef: "7f1c9b2e4d6a8c0f1e3b5d7a9c2e4f6081a3c5e7" },
      } as PaymentState;
      // The panel reads the refund key off the request's world.
      void createMockCoinageSession({
        recipient: DEPOSIT.address,
        amount: 5_000_000n,
        sourceId: "usdt-tron",
      }).then((world) => {
        s.mock = world;
      });
    },
  },
  {
    name: "success",
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
    name: "resume spinner",
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
