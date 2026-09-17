// Fixture request records in today's `ActiveFlowRecord` shape, one per state the session store
// writes, built the way its writers build them, plus the worker's jobs blob for them. The parity
// oracle projects these; the later milestones migrate them.

import type { FundingStep } from "@getsome/funding";
import type { ActiveFlowRecord } from "../../app/stores/session";
import {
  advanceFundingProgressSnapshot,
  createFundingProgressSnapshot,
  fundingProgressSignalForSharedStep,
  MELD_PAYMENT_STAGE,
  progressProviderForSource,
  type FundingProgressProfile,
  type FundingProgressSignal,
  type FundingProgressSnapshot,
} from "../../app/funding/progress";
import { CRYPTO_SOURCE_ID } from "../../app/funding/source-ids";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The instant the parity suite projects at; every fixture event lies before it. */
export const FIXTURE_NOW = Date.UTC(2025, 4, 6, 18, 0, 0);
const minutesAgo = (minutes: number) => FIXTURE_NOW - minutes * MINUTE;

/** The Asset Hub account a request's deposit lands on. */
const BURNER_ADDRESS = "14uAyRtbeRsrgERPLETm72yFPKW3oi3m4RX93arNwGQhsduC";

/** What `initialProgress` projects for the whole journey: the user's delay, then every stage. */
const journeyDurationMs = (profile: FundingProgressProfile) =>
  profile.expectedUserDelayMs + profile.stages.reduce((total, stage) => total + stage.nominalMs, 0);

/** The crypto quote's ETA, which scales the route's ingress stages. */
const CRYPTO_ETA_SECONDS = 600;

/** The snapshot `persistActiveFlow` writes for a crypto request. */
function initialCryptoProgress(startedAt: number): FundingProgressSnapshot {
  const profile = progressProviderForSource(CRYPTO_SOURCE_ID).createProfile({
    ingressDurationMs: CRYPTO_ETA_SECONDS * 1_000,
  });
  return createFundingProgressSnapshot(profile, {
    preDetectionEstimateText: `≈${CRYPTO_ETA_SECONDS / 60} min after your transfer`,
    estimatedCompletionAt: startedAt + journeyDurationMs(profile),
  });
}

/** The snapshot `persistActiveFlow` writes for a card request. */
function initialCardProgress(startedAt: number): FundingProgressSnapshot {
  const profile = progressProviderForSource("meld-card").createProfile({
    ingressDurationMs: 5 * MINUTE,
  });
  return createFundingProgressSnapshot(profile, {
    preDetectionEstimateText: "≈ minutes after you pay",
    estimatedCompletionAt: startedAt + journeyDurationMs(profile),
  });
}

/** The signals the store recorded on the snapshot, in the order they landed. */
function recorded(
  snapshot: FundingProgressSnapshot,
  events: readonly (readonly [FundingProgressSignal, number])[],
): FundingProgressSnapshot {
  return events.reduce(
    (current, [signal, at]) => advanceFundingProgressSnapshot(current, { ...signal, at }),
    snapshot,
  );
}

/** The first payment state after a start, on either rail. */
const WAITING: FundingProgressSignal = { observation: { kind: "waiting" }, routeStatus: "waiting" };
/** The Meld poll once the buyer left the widget, then once the provider settled. */
const MELD_RECEIVING: FundingProgressSignal = {
  observation: { kind: "stage", stageKey: MELD_PAYMENT_STAGE },
  routeStatus: "receiving",
};
const MELD_COMPLETE: FundingProgressSignal = {
  observation: { kind: "route-complete" },
  routeStatus: "complete",
};
/** The worker's first step past the deposit. */
const SWAP = fundingProgressSignalForSharedStep("swap");
const FAILED: FundingProgressSignal = { observation: { kind: "failed" } };
const SETTLED: FundingProgressSignal = { observation: { kind: "settled" } };

// (a) A crypto request still waiting for its deposit, inside the channel's window.
const DOT3_STARTED = minutesAgo(30);
export const awaitingDepositCryptoRecord: ActiveFlowRecord = {
  amountHuman: "25",
  chain: "Bitcoin",
  asset: "BTC",
  sourceAmount: "0.00023",
  sourceSymbol: "BTC",
  startedAt: DOT3_STARTED,
  depositAddress: "bc1q-fixture-deposit-3",
  progress: recorded(initialCryptoProgress(DOT3_STARTED), [[WAITING, DOT3_STARTED]]),
  tradeN: 3,
  sourceId: CRYPTO_SOURCE_ID,
  depositExpiresAt: DOT3_STARTED + DAY,
};

// (b) A crypto request whose deposit the worker has seen and started converting.
const DOT4_STARTED = minutesAgo(20);
const DOT4_FUNDED = minutesAgo(15);
export const fundedCryptoRecord: ActiveFlowRecord = {
  amountHuman: "40",
  chain: "Ethereum",
  asset: "ETH",
  sourceAmount: "0.0158",
  sourceSymbol: "ETH",
  startedAt: DOT4_STARTED,
  depositAddress: "0x-fixture-deposit-4",
  progress: recorded(initialCryptoProgress(DOT4_STARTED), [
    [WAITING, DOT4_STARTED],
    [SWAP, DOT4_FUNDED],
  ]),
  tradeN: 4,
  sourceId: CRYPTO_SOURCE_ID,
  funded: DOT4_FUNDED,
};

// (c) A card request the buyer has paid in the widget; the provider is confirming it.
const CARD2_STARTED = minutesAgo(40);
const CARD2_SUBMITTED = minutesAgo(38);
export const submittedCardRecord: ActiveFlowRecord = {
  amountHuman: "50",
  chain: "Meld",
  asset: "Card",
  sourceAmount: "52.06",
  sourceSymbol: "USD",
  sourceFee: "1.56",
  sourceNetworkFee: "0.01",
  startedAt: CARD2_STARTED,
  depositAddress: BURNER_ADDRESS,
  progress: recorded(initialCardProgress(CARD2_STARTED), [
    [WAITING, CARD2_STARTED],
    [MELD_RECEIVING, CARD2_SUBMITTED],
  ]),
  tradeN: 2,
  sourceId: "meld-card",
  meldFundingRequestId: "mfr-fixture-card-2",
  meldCountry: "US",
  meldSubmittedAt: CARD2_SUBMITTED,
};

// (d) A card request the worker claimed: settled history, with the amount the claim swept.
const CARD1_STARTED = minutesAgo(90);
const CARD1_SUBMITTED = minutesAgo(88);
const CARD1_FUNDED = minutesAgo(85);
const CARD1_SETTLED = minutesAgo(80);
export const settledCardRecord: ActiveFlowRecord = {
  amountHuman: "50",
  chain: "Meld",
  asset: "Card",
  sourceAmount: "52.06",
  sourceSymbol: "USD",
  sourceFee: "1.56",
  sourceNetworkFee: "0.01",
  startedAt: CARD1_STARTED,
  depositAddress: BURNER_ADDRESS,
  progress: recorded(initialCardProgress(CARD1_STARTED), [
    [WAITING, CARD1_STARTED],
    [MELD_RECEIVING, CARD1_SUBMITTED],
    [MELD_COMPLETE, CARD1_FUNDED],
    [SWAP, CARD1_FUNDED],
    [SETTLED, CARD1_SETTLED],
  ]),
  tradeN: 1,
  sourceId: "meld-card",
  meldFundingRequestId: "mfr-fixture-card-1",
  meldCountry: "US",
  meldSubmittedAt: CARD1_SUBMITTED,
  funded: CARD1_FUNDED,
  settledAt: CARD1_SETTLED,
  claimed: "50250000",
};

// (e) A crypto request the worker gave up on: the deposit was below the swap minimum.
const DOT2_STARTED = minutesAgo(60);
const DOT2_FAILED = minutesAgo(50);
const SHORTFALL_REASON = "shortfall: the deposit is below the swap minimum";
export const failedCryptoRecord: ActiveFlowRecord = {
  amountHuman: "5",
  chain: "Bitcoin",
  asset: "BTC",
  sourceAmount: "0.00004545",
  sourceSymbol: "BTC",
  startedAt: DOT2_STARTED,
  depositAddress: "bc1q-fixture-deposit-2",
  progress: recorded(initialCryptoProgress(DOT2_STARTED), [
    [WAITING, DOT2_STARTED],
    [FAILED, DOT2_FAILED],
  ]),
  tradeN: 2,
  sourceId: CRYPTO_SOURCE_ID,
  funded: DOT2_FAILED,
  failureReason: SHORTFALL_REASON,
};

// (f) A crypto request the user cancelled before paying: a tombstone until its window closes.
const DOT1_STARTED = minutesAgo(120);
const DOT1_CANCELLED = minutesAgo(110);
export const cancelledCryptoRecord: ActiveFlowRecord = {
  amountHuman: "10",
  chain: "Solana",
  asset: "SOL",
  sourceAmount: "0.071",
  sourceSymbol: "SOL",
  startedAt: DOT1_STARTED,
  depositAddress: "sol-fixture-deposit-1",
  progress: recorded(initialCryptoProgress(DOT1_STARTED), [[WAITING, DOT1_STARTED]]),
  tradeN: 1,
  sourceId: CRYPTO_SOURCE_ID,
  depositExpiresAt: DOT1_STARTED + DAY,
  cancelledAt: DOT1_CANCELLED,
};

// (g) A record from before source ids and progress snapshots, stored under the bare key.
const LEGACY7_STARTED = FIXTURE_NOW - 3 * DAY;
export const LEGACY_BARE_REF_KEY = "getsome:request:7";
export const legacyBareRefRecord: ActiveFlowRecord = {
  amountHuman: "15",
  chain: "Bitcoin",
  asset: "BTC",
  sourceAmount: "0.00014",
  sourceSymbol: "BTC",
  startedAt: LEGACY7_STARTED,
  depositAddress: "bc1q-fixture-deposit-7",
  tradeN: 7,
};

/** Every fixture record, newest first, as `readAllRequests` orders them. */
export const fixtureRecords: readonly ActiveFlowRecord[] = [
  fundedCryptoRecord,
  awaitingDepositCryptoRecord,
  submittedCardRecord,
  failedCryptoRecord,
  settledCardRecord,
  cancelledCryptoRecord,
  legacyBareRefRecord,
];

/** A funding job as `worker/src/engine.js` persists it, keyed by its session id. */
export interface WorkerJobRecord {
  v: 1;
  sessionId: string;
  label: string;
  burnerAddress: string;
  depositExpiresAt: number | null;
  settleAmount: string;
  remoteFeeBuffer: string;
  keepNativeForFees: string;
  slippagePct: number;
  underlyingAssetId: number;
  peopleParaId: number;
  assetHubGenesis: string;
  peopleGenesis: string;
  phase: "starting" | FundingStep | "failed";
  failure?: "shortfall" | "timeout" | "expired" | "cancelled";
  done: boolean;
  createdAt: number;
  armedAt: number;
  lastTickAt: number | null;
  lastError?: string;
  state: {
    swapSubmitted: boolean;
    xcmSubmitted: boolean;
    peopleAtXcm: string;
    fundsSeenAt: number | null;
    workedMs: number;
  };
  txs: { call: "swap" | "xcm"; txHash: string; block?: number }[];
  claim?: {
    phase: "sizing" | "registering" | "claiming" | "claimed";
    amount: string;
    at: number;
    attempts: number;
  };
}

const SWAP_TX_HASH = `0x${"11".repeat(32)}`;
const XCM_TX_HASH = `0x${"22".repeat(32)}`;

/** A job the surface just handed over, awaiting its deposit. The chain settings are the
 *  surface's configuration, which the store never reads. */
function workerJob(
  sourceId: string,
  tradeN: number,
  startedAt: number,
  settleAmount: string,
  overrides: Partial<WorkerJobRecord> = {},
): WorkerJobRecord {
  return {
    v: 1,
    sessionId: `${sourceId}:${tradeN}`,
    label: `onramp:eph:${sourceId}:${tradeN}`,
    burnerAddress: BURNER_ADDRESS,
    depositExpiresAt: startedAt + DAY,
    settleAmount,
    remoteFeeBuffer: "500000000",
    keepNativeForFees: "100000000",
    slippagePct: 1,
    underlyingAssetId: 1337,
    peopleParaId: 1004,
    assetHubGenesis: `0x${"aa".repeat(32)}`,
    peopleGenesis: `0x${"bb".repeat(32)}`,
    phase: "await-native",
    done: false,
    createdAt: startedAt,
    armedAt: startedAt,
    lastTickAt: startedAt + MINUTE,
    state: {
      swapSubmitted: false,
      xcmSubmitted: false,
      peopleAtXcm: "0",
      fundsSeenAt: null,
      workedMs: 0,
    },
    txs: [],
    ...overrides,
  };
}

/** The worker's jobs for the fixture records, plus one whose record was never written. */
export const fixtureWorkerJobs: Readonly<Record<string, WorkerJobRecord>> = {
  "meld-card:1": workerJob("meld-card", 1, CARD1_STARTED, "50000000", {
    phase: "done",
    done: true,
    lastTickAt: CARD1_SETTLED,
    state: {
      swapSubmitted: true,
      xcmSubmitted: true,
      peopleAtXcm: "50250000",
      fundsSeenAt: CARD1_FUNDED,
      workedMs: 4 * MINUTE,
    },
    txs: [
      { call: "swap", txHash: SWAP_TX_HASH, block: 8_000_101 },
      { call: "xcm", txHash: XCM_TX_HASH, block: 8_000_120 },
    ],
    claim: { phase: "claimed", amount: "50250000", at: CARD1_SETTLED, attempts: 1 },
  }),
  "dot-assethub:2": workerJob(CRYPTO_SOURCE_ID, 2, DOT2_STARTED, "5000000", {
    phase: "failed",
    failure: "shortfall",
    lastError: SHORTFALL_REASON,
    lastTickAt: DOT2_FAILED,
    state: {
      swapSubmitted: false,
      xcmSubmitted: false,
      peopleAtXcm: "0",
      fundsSeenAt: DOT2_FAILED - MINUTE,
      workedMs: MINUTE,
    },
  }),
  "dot-assethub:4": workerJob(CRYPTO_SOURCE_ID, 4, DOT4_STARTED, "40000000", {
    phase: "swap",
    lastTickAt: minutesAgo(1),
    state: {
      swapSubmitted: true,
      xcmSubmitted: false,
      peopleAtXcm: "0",
      fundsSeenAt: DOT4_FUNDED,
      workedMs: 14 * MINUTE,
    },
    txs: [{ call: "swap", txHash: SWAP_TX_HASH, block: 8_000_450 }],
  }),
  "dot-assethub:3": workerJob(CRYPTO_SOURCE_ID, 3, DOT3_STARTED, "25000000"),
  "dot-assethub:9": workerJob(CRYPTO_SOURCE_ID, 9, minutesAgo(5), "12000000"),
};

/** The jobs as stored under `getsome.funding.jobs`. */
export const fixtureWorkerJobsBlob = JSON.stringify(fixtureWorkerJobs);
