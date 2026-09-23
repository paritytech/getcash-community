// The finished top-ups the preview deck and the launch simulation put behind the clock.
//
// Running top-ups are not here: a scene seeds those as real records and the package adapters
// project them, so their rows carry the request's own id, the progress machine's own label and
// the record's own quote — see `seedRunningTopUps` in `dev-preview`. A finished one is built by
// hand on purpose. The journey a history row opens has to stand up with no live request behind
// it, which is the state a hand-made row models exactly; seeding a record instead would hand that
// journey a live foreground and stop exercising the path it was written for.

import { shallowRef } from "vue";
import type { FundingShellEntryScreen } from "../funding/navigation";
import type { FundingProgressProjection, FundingProgressView } from "../funding/progress";
import type { FundingRoute } from "../funding/selection";
import type { FundingTopUp } from "../funding/top-ups";

export interface PreviewTopUpScene {
  /** Rows the scene supplies itself, listed alongside whatever the adapters project from the
   *  records it seeded. Finished top-ups only; see this module's header. */
  topUps?: readonly FundingTopUp[];
  /** Draw the screen's loading placeholder instead of the cards. */
  skeleton?: boolean;
  /**
   * Where the shell enters. The keyboard deck sends itself straight to the list ("pending"); the
   * launch simulation leaves it on "auto" so the real entry rule decides, which is the whole
   * point of that scenario.
   */
  entry?: FundingShellEntryScreen;
  /** The list's own error line, as a failed open would leave it. */
  error?: string;
}

/**
 * Non-null only while a top-ups preview scene is on screen; the shell reads its cards instead of
 * the adapters'. Always null in a production build — `dev-preview` and the `?preview=top-ups`
 * launch flag are its only writers, and both are gated on `isDemoBuild()`.
 */
export const previewTopUpScene = shallowRef<PreviewTopUpScene | null>(null);

const MINUTE = 60_000;
const HOUR = 60;
const DAY = 24 * HOUR;

/** A top-up that has stopped moving: the only kind built by hand. */
type FinishedKind = Extract<FundingProgressView["kind"], "settled" | "failed">;

/** How far along the ring is drawn for each ending. */
const RING_VALUE: Record<FinishedKind, number> = {
  failed: 0.55,
  settled: 1,
};

function projection(
  kind: FinishedKind,
  label: string,
  endedAt: number,
  detectedAt?: number,
): FundingProgressProjection {
  const value = RING_VALUE[kind];
  const view: FundingProgressView = {
    kind,
    value,
    valueNow: Math.round(value * 100),
    label,
    valueText: `${Math.round(value * 100)}%`,
    activeNodeIndex: 0,
    stageElapsedMs: 90_000,
    nodes: [],
  };
  return {
    view,
    estimateText: "≈10 min after your transfer",
    cadenceMs: 1_000,
    // Whether the payment was ever seen decides where the journey's failed marker lands: without
    // it the stepper strikes "Started", which is wrong for anything that failed after paying.
    ...(detectedAt === undefined ? {} : { detectedAt }),
    ...(kind === "settled" ? { settledAt: endedAt } : {}),
    ...(kind === "failed" ? { failedAt: endedAt } : {}),
    stageTimestamps: {},
  };
}

/**
 * A plausible quote for the budget, so every preview card's detail has its Fees and Total rows.
 * The real records always carry one — `quoteOf` reads it off the persisted request — so a card
 * without it would be a mock artefact, not a state worth styling. Shared with the records a
 * running scene seeds, which persist these same figures.
 */
export function previewQuote(route: FundingRoute, amount: string): FundingTopUp["quote"] {
  const cash = Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(cash) || cash <= 0) return undefined;
  // The crypto rail quotes the source coin; the fiat rails quote the charge, fee included.
  if (route === "crypto") return { amount: (cash * 0.000009).toFixed(8), symbol: "BTC" };
  // The fiat split as the design frames show it: about 1.1% of the charge, most of it the
  // provider's. Carried in full because the fee row drills into the breakdown, which itemizes it.
  const transactionFee = cash * 0.0084;
  const networkFee = cash * 0.0018;
  const partnerFee = cash * 0.0008;
  const fee = transactionFee + networkFee + partnerFee;
  return {
    amount: (cash + fee).toFixed(2),
    symbol: "EUR",
    fee: fee.toFixed(2),
    transactionFee: transactionFee.toFixed(2),
    networkFee: networkFee.toFixed(2),
    partnerFee: partnerFee.toFixed(2),
  };
}

interface PreviewCardOptions {
  amount?: string;
  /** How long ago the top-up was started. */
  startedMinutesAgo?: number;
  /** How long ago it settled or failed. Defaults to a few minutes after it started. */
  endedMinutesAgo?: number;
  /** A failed top-up whose deposit went back to the buyer: "Refunded", not "Payment failed". */
  refunded?: boolean;
  /** A top-up whose deposit window closed with nothing paid: "Expired" on the marker, and no
   *  money rows — nobody was ever charged. */
  expired?: boolean;
  /** What the rail quoted, for the journey's Fees and Total rows. */
  quote?: FundingTopUp["quote"];
  /** The fiat rails' receipt facts: the provider the request was opened with, and the funding
   *  request's id, which the journey shows as the transaction id. */
  provider?: string;
  reference?: string;
  /** The request a crypto top-up is, so the journey can reach its refund key from the record. */
  request?: { sourceId: string; tradeN: number };
  /** What a refund actually returned, and the chain transaction that returned it. */
  refundAmount?: string;
  refundTxRef?: string;
  /** How many of the journey's markers are done, as the record counted them. Defaults to what
   *  `kind` implies; set it where the label says more than the kind does. */
  journeyDone?: number;
}

/**
 * The marker count a record of this shape would have made, on the route's own scale.
 *
 * The journey opened from history reads this off the row, so a deck scene that leaves it out
 * draws the top-up as though it never started. A refunded top-up counts its payment: the money
 * was taken before it came back.
 */
function defaultJourneyDone(route: FundingRoute, kind: FinishedKind, refunded: boolean): number {
  const crypto = route === "crypto";
  if (kind === "settled") return crypto ? 3 : 5;
  return refunded ? (crypto ? 1 : 2) : crypto ? 0 : 1;
}

/**
 * One finished top-up. `kind` picks the glyph, the ring and which list it lands in; `label` is
 * the failure's stored reason, which is all a journey reopened from history has to go on.
 */
export function previewTopUp(
  id: string,
  route: FundingRoute,
  kind: FinishedKind,
  label: string,
  options: PreviewCardOptions = {},
): FundingTopUp {
  const amount = options.amount ?? "50";
  const now = Date.now();
  const startedAgo = options.startedMinutesAgo ?? 12;
  const startedAt = now - startedAgo * MINUTE;
  const endedAt = now - (options.endedMinutesAgo ?? Math.max(0, startedAgo - 8)) * MINUTE;
  // A finished top-up always had its payment seen. Where the journey's failed marker lands
  // depends on it: without it the stepper strikes "Started", which is wrong for anything that
  // failed after paying.
  const detectedAt = startedAt + 2 * MINUTE;
  const state: FundingTopUp["state"] =
    kind === "settled"
      ? { kind: "settled", at: endedAt, creditedAmount: amount }
      : {
          kind: "failed",
          at: endedAt,
          reason: label,
          ...(options.expired === true ? { expired: true } : {}),
          ...(options.refunded === true ? { refunded: true } : {}),
          ...(options.refundAmount ? { refundAmount: options.refundAmount } : {}),
          ...(options.refundTxRef ? { refundTxRef: options.refundTxRef } : {}),
        };
  return {
    id,
    amount,
    route,
    startedAt,
    progress: projection(kind, label, endedAt, detectedAt),
    ...(() => {
      const quote = options.quote ?? previewQuote(route, amount);
      return quote === undefined ? {} : { quote };
    })(),
    journeyDone: options.journeyDone ?? defaultJourneyDone(route, kind, options.refunded === true),
    ...(options.request ? { request: options.request } : {}),
    ...(options.reference ? { reference: options.reference } : {}),
    ...(options.provider
      ? { details: { provider: { label: options.provider, icon: "/icons/card.svg" } } }
      : {}),
    state,
  };
}

/** The finished top-ups behind the clock: a credit, a declined card, a refunded swap, an older
 *  bank transfer. Shared by the launch simulation and the history scene. */
export function previewTopUpHistory(): FundingTopUp[] {
  return [
    previewTopUp("p3", "crypto", "settled", "Added to your balance", {
      amount: "80",
      quote: { amount: "0.00072", symbol: "BTC" },
      startedMinutesAgo: 6 * HOUR,
      endedMinutesAgo: 6 * HOUR - 9,
    }),
    previewTopUp("p4", "card", "failed", "The card issuer declined the payment", {
      amount: "200",
      quote: { amount: "212.40", symbol: "EUR", fee: "12.40" },
      provider: "Transak",
      reference: "a1f9c3d2-4c2e-4a71-9f0b-6d5e8c2b1a03",
      startedMinutesAgo: DAY + 3 * HOUR,
      endedMinutesAgo: DAY + 3 * HOUR - 2,
    }),
    previewTopUp("p5", "crypto", "failed", "The rate moved too far to complete the swap", {
      amount: "50",
      quote: { amount: "0.00045", symbol: "BTC" },
      refunded: true,
      // Base units, as the rail reports them: 0.00043 BTC at 8 decimals. Less than the 0.00045
      // deposit — the refund pays its own network fees on the way back.
      refundAmount: "43000",
      refundTxRef: "7f1c9b2e4d6a8c0f1e3b5d7a9c2e4f6081a3c5e7",
      request: { sourceId: "btc", tradeN: 5 },
      startedMinutesAgo: 3 * DAY,
      endedMinutesAgo: 3 * DAY - 14,
    }),
    previewTopUp("p8", "card", "failed", "Refunded to your card", {
      amount: "50",
      quote: { amount: "50.55", symbol: "EUR", fee: "0.55" },
      refunded: true,
      provider: "Transak",
      reference: "b7e4a10c-9d31-4f62-8ab5-3c0f7e19d248",
      startedMinutesAgo: 4 * DAY,
      endedMinutesAgo: 4 * DAY - 6,
    }),
    // The oldest history: the funding-request id was always persisted, so the reference is
    // there, but neither of the provider's names was kept — not the create call's, not the
    // quote's. `topUpDetails` names the aggregator rather than leaving the row blank.
    previewTopUp("p9", "card", "failed", "Refunded to your card", {
      amount: "30",
      quote: { amount: "31.80", symbol: "EUR", fee: "1.80" },
      refunded: true,
      provider: "Meld",
      reference: "0f2c8d41-7b93-4e05-a1d6-84be3f7c0925",
      startedMinutesAgo: 9 * DAY,
      endedMinutesAgo: 9 * DAY - 5,
    }),
    // The two expired endings, as the record keeps them: the deposit window closed with nothing
    // paid, so the journey says "Expired" and shows no money rows — card included, although its
    // route would otherwise get the failure receipt.
    previewTopUp("p10", "crypto", "failed", "Channel expired", {
      amount: "60",
      quote: { amount: "0.00054", symbol: "BTC" },
      expired: true,
      startedMinutesAgo: 5 * DAY,
      endedMinutesAgo: 5 * DAY - 24 * 60,
    }),
    previewTopUp("p11", "card", "failed", "Channel expired", {
      amount: "40",
      expired: true,
      startedMinutesAgo: 7 * DAY,
      endedMinutesAgo: 7 * DAY - 24 * 60,
    }),
    previewTopUp("p6", "bank", "settled", "Added to your balance", {
      amount: "25",
      startedMinutesAgo: 6 * DAY,
      endedMinutesAgo: 6 * DAY - 2 * HOUR,
    }),
    // The widest amount the design draws, against the longest route pill.
    previewTopUp("p7", "card", "settled", "Added to your balance", {
      amount: "1,000",
      startedMinutesAgo: 12 * DAY,
      endedMinutesAgo: 12 * DAY - 4,
    }),
  ];
}

/**
 * The launch scenario's history. The two top-ups still running are seeded as records by
 * `seedLaunchPreviewTopUps`; both land before the shell's first interactive render so
 * `resolveFundingShellScreen` decides the entry screen itself, which is the whole point of the
 * scenario. Reachable in a dev or demo build with `?preview=top-ups`.
 */
export function launchPreviewTopUps(): PreviewTopUpScene {
  return { topUps: previewTopUpHistory(), entry: "auto" };
}
