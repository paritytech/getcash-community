// The Meld card and bank routes' provider part: Started, Accepted and Sent from Meld's statuses,
// and one time-moved part in each of phases 1 and 2.

import { formatWhenInline } from "../../utils/journey";
import type { TopUpRecord } from "../requests/model";
import { factAt, observedFrom } from "./observed";
import { delay, normal, type TextState, type TimelineMessage, type TimelineRoute } from "./route";
import type { PhasePart } from "./types";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** Meld's statuses as the record observes them: a transaction, `SETTLING`, `SETTLED`. */
const STATUSES = ["receiving", "sending", "complete"] as const;

const reachedAt = (record: TopUpRecord, status: (typeof STATUSES)[number]): number | undefined =>
  observedFrom(record, STATUSES, status);

/** The user finished the widget or tapped "I've sent funds", or Meld reported a transaction. */
function startedAt(record: TopUpRecord): number | undefined {
  const times = [record.meldSubmittedAt, reachedAt(record, "receiving")].filter(
    (at) => at !== undefined,
  );
  return times.length === 0 ? undefined : Math.min(...times);
}

/** Meld `ERROR`: a temporary status the provider retries. */
const providerError = (record: TopUpRecord): boolean => record.rail.delayed === true;

/** What one Meld payment method sets in phases 1 and 2. */
interface MeldMethod {
  /** Phase 1's one part. */
  readonly firstPart: PhasePart;
  /** Whether Meld `ERROR` delays phase 1. */
  readonly errorDelaysFirst: boolean;
  firstMessage(record: TopUpRecord): TimelineMessage;
  /** Phase 1's detail line, when the method has one. */
  firstDetail?(record: TopUpRecord, state: TextState): string | undefined;
  /** Phase 2's text on Meld `ERROR`. */
  readonly retryingText: string;
}

function meldRoute(method: MeldMethod): TimelineRoute {
  return {
    milestones: (record) => ({
      started: factAt(startedAt(record)),
      accepted: factAt(reachedAt(record, "sending")),
      sent: factAt(reachedAt(record, "complete")),
    }),
    phase(record, index) {
      const delayed = providerError(record) && (index === 1 || method.errorDelaysFirst);
      const part = index === 0 ? method.firstPart : { weight: 1, expectedMs: 5 * MINUTE };
      return { parts: [part], delayed };
    },
    seenExpectedMs: 30 * SECOND,
    lastReadAt: (record) => record.witnesses.provider?.at,
    text(record, index, state) {
      if (index === 0) {
        return {
          message: method.firstMessage(record),
          detail: method.firstDetail?.(record, state),
        };
      }
      return {
        message: providerError(record)
          ? delay(method.retryingText)
          : normal("Your money is on its way"),
      };
    },
  };
}

export const meldCardRoute = meldRoute({
  firstPart: { weight: 1, expectedMs: 2 * MINUTE },
  errorDelaysFirst: true,
  firstMessage: (record) =>
    providerError(record)
      ? delay("The payment provider hit a problem and is retrying. Don't pay again.")
      : normal("Checking your payment"),
  retryingText: "The payment provider is retrying the transfer. Don't pay again.",
});

/** Only shapes the line's curve: a bank transfer's time is opaque. */
const TRANSFER_CURVE_MS = 3 * DAY;

export const meldBankRoute = meldRoute({
  firstPart: { weight: 1, expectedMs: TRANSFER_CURVE_MS },
  errorDelaysFirst: false,
  firstMessage: () =>
    normal(
      "If you've sent the money from your bank, it's on its way. Bank transfers can take a few days. This page will update when it arrives.",
    ),
  firstDetail(record, { now, locale }) {
    const sentAt = startedAt(record);
    return sentAt === undefined ? undefined : `Sent ${formatWhenInline(sentAt, locale, now)}`;
  },
  retryingText: "The payment provider is retrying the transfer. Don't send the money again.",
});
