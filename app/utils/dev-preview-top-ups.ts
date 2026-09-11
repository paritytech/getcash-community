// Fake top-ups for the preview deck and the launch simulation.
//
// The real list is pulled by the package adapters (`useChainflipTopUpAdapter`,
// `useMeldTopUpAdapter`): each projects `session.requestList` — the persisted request records —
// against the live `session.requestStatus`, and `session.resumeOpenRequests()` is the refresh.
// That path returns nothing outside a hosted build, so there is no way to see the top-ups list or
// history with content on a plain dev server. These stand in for the adapters' output, at the same
// `FundingTopUp` shape, so `projectFundingTopUps` splits them into in-progress, past and
// latest-settled exactly as it would the real thing.
//
// The projections are built by hand rather than driven through the progress state machine: the
// deck needs one exact label per card, including the rail-supplied delay wording that no provider
// stage defines.

import { shallowRef } from "vue";
import type { FundingShellEntryScreen } from "../funding/navigation";
import type { FundingProgressProjection, FundingProgressView } from "../funding/progress";
import type { FundingRoute } from "../funding/selection";
import type { FundingTopUp } from "../funding/top-ups";

export interface PreviewTopUpScene {
  topUps: readonly FundingTopUp[];
  /** Draw the screen's loading placeholder instead of the cards. */
  skeleton?: boolean;
  /**
   * Where the shell enters. The keyboard deck sends itself straight to the list ("pending"); the
   * launch simulation leaves it on "auto" so the real entry rule decides, which is the whole
   * point of that scenario.
   */
  entry?: FundingShellEntryScreen;
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

type CardKind = FundingProgressView["kind"];

/** How far along the ring is drawn for each state. */
const RING_VALUE: Record<CardKind, number> = {
  waiting: 0.08,
  active: 0.55,
  failed: 0.55,
  settled: 1,
};

function projection(
  kind: CardKind,
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
 * without it would be a mock artefact, not a state worth styling.
 */
function defaultQuote(route: FundingRoute, amount: string): FundingTopUp["quote"] {
  const cash = Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(cash) || cash <= 0) return undefined;
  // The crypto rail quotes the source coin; the fiat rails quote the charge, fee included.
  if (route === "crypto") return { amount: (cash * 0.000009).toFixed(8), symbol: "BTC" };
  const fee = cash * 0.06;
  return { amount: (cash + fee).toFixed(2), symbol: "EUR", fee: fee.toFixed(2) };
}

interface PreviewCardOptions {
  amount?: string;
  /** The rail is retrying or late: the status line goes amber. */
  delayed?: boolean;
  /** How long ago the top-up was started. */
  startedMinutesAgo?: number;
  /** How long ago it settled or failed. Defaults to a few minutes after it started. */
  endedMinutesAgo?: number;
  /** A failed top-up whose deposit went back to the buyer: "Refunded", not "Payment failed". */
  refunded?: boolean;
  /** What the rail quoted, for the journey's Fees and Total rows. */
  quote?: FundingTopUp["quote"];
}

/**
 * One top-up. `kind` picks the glyph, the ring and which list it lands in; `label` is the status
 * line, which for every running state is also the rail's own word on it.
 */
export function previewTopUp(
  id: string,
  route: FundingRoute,
  kind: CardKind,
  label: string,
  options: PreviewCardOptions = {},
): FundingTopUp {
  const amount = options.amount ?? "50";
  const now = Date.now();
  const startedAgo = options.startedMinutesAgo ?? 12;
  const startedAt = now - startedAgo * MINUTE;
  const endedAt = now - (options.endedMinutesAgo ?? Math.max(0, startedAgo - 8)) * MINUTE;
  // Everything past the deposit has had its payment seen; only a waiting top-up has not.
  const detectedAt = kind === "waiting" ? undefined : startedAt + 2 * MINUTE;
  const state: FundingTopUp["state"] =
    kind === "settled"
      ? { kind: "settled", at: endedAt, creditedAmount: amount }
      : kind === "failed"
        ? {
            kind: "failed",
            at: endedAt,
            reason: label,
            ...(options.refunded === true ? { refunded: true } : {}),
          }
        : kind === "waiting"
          ? { kind: "awaiting-transfer", status: label }
          : { kind: "finishing", status: label };
  return {
    id,
    amount,
    route,
    startedAt,
    progress: projection(kind, label, endedAt, detectedAt),
    ...(() => {
      const quote = options.quote ?? defaultQuote(route, amount);
      return quote === undefined ? {} : { quote };
    })(),
    ...(options.delayed === true ? { delayed: true } : {}),
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
      startedMinutesAgo: DAY + 3 * HOUR,
      endedMinutesAgo: DAY + 3 * HOUR - 2,
    }),
    previewTopUp("p5", "crypto", "failed", "The rate moved too far to complete the swap", {
      amount: "50",
      quote: { amount: "0.00045", symbol: "BTC" },
      refunded: true,
      startedMinutesAgo: 3 * DAY,
      endedMinutesAgo: 3 * DAY - 14,
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
 * The launch scenario: two top-ups still running, plus the history behind the clock, seeded before
 * the shell's first interactive render so `resolveFundingShellScreen` decides the entry screen
 * itself. Reachable in a dev or demo build with `?preview=top-ups`.
 */
export function launchPreviewTopUps(): PreviewTopUpScene {
  return {
    topUps: [
      previewTopUp("p1", "crypto", "waiting", "Waiting for your transfer", {
        startedMinutesAgo: 4,
      }),
      previewTopUp("p2", "card", "active", "Converting to $CASH", {
        amount: "120",
        startedMinutesAgo: 21,
      }),
      ...previewTopUpHistory(),
    ],
    entry: "auto",
  };
}
