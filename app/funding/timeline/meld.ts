// The Meld card and bank routes' provider part: Started, Accepted and Sent from Meld's statuses,
// one time-moved part in each of phases 1 and 2, and their failures.

import { formatWhenInline } from "../../utils/journey";
import { fmtFiat } from "../../utils/money";
import type { TopUpRecord } from "../requests/model";
import { meldProviderName } from "../top-up-projection";
import {
  CLOSE,
  START_OVER,
  expiredEnding,
  failureCode,
  type FailureDetails,
  type PartFailure,
} from "./failure";
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

/** How a Meld payment ended, as the record can tell. */
type MeldEnding = "declined" | "failed" | "expired" | "unobserved" | "refunded";

/** The ending from the code the rail or core kept. An ending without a code the routes know reads
 *  as `unobserved`: nothing tells that no money moved. */
function meldEnding(record: TopUpRecord): MeldEnding {
  if (expiredEnding(record)) return "expired";
  switch (failureCode(record)) {
    case "declined":
      return "declined";
    case "failed":
    case "cancelled":
    case "refused":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      return "unobserved";
  }
}

/** Meld's own status behind each code that names exactly one. */
const PROVIDER_STATUSES: Readonly<Record<string, string>> = {
  declined: "DECLINED",
  cancelled: "CANCELLED",
  refunded: "REFUNDED",
};

/** The words a Meld failure text fills in: the provider, and what the payment was charged. */
interface EndingWords {
  readonly provider: string;
  readonly charged?: string;
}

function endingWords(record: TopUpRecord): EndingWords {
  const { sourceAmount, sourceSymbol } = record;
  return {
    provider: meldProviderName(record),
    ...(sourceAmount && sourceSymbol ? { charged: fmtFiat(sourceAmount, sourceSymbol) } : {}),
  };
}

function meldFailureDetails(record: TopUpRecord): FailureDetails {
  const code = failureCode(record);
  return {
    provider: meldProviderName(record),
    reason: code === undefined ? undefined : PROVIDER_STATUSES[code],
    reference: record.meldFundingRequestId,
  };
}

/** What one Meld payment method sets: phases 1 and 2, and the texts of its failures. */
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
  readonly failures: Readonly<Record<MeldEnding, (words: EndingWords) => PartFailure>>;
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
    failure: (record) => method.failures[meldEnding(record)](endingWords(record)),
    failureDetails: meldFailureDetails,
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
  failures: {
    declined: () => ({
      text: "Your bank declined the payment. No money was taken.",
      action: START_OVER,
    }),
    failed: () => ({
      text: "The payment didn't go through. No money was taken.",
      action: START_OVER,
    }),
    expired: () => ({
      text: "We didn't receive your payment. No money was taken.",
      action: START_OVER,
    }),
    unobserved: ({ provider }) => ({
      text: `We can't confirm your payment with ${provider}. Check your card statement before you pay again.`,
      action: CLOSE,
    }),
    refunded: ({ provider, charged = "the money" }) => ({
      text: `${provider} couldn't complete your top-up and is returning ${charged} to your card.`,
      action: START_OVER,
    }),
  },
});

const notAccepted = (provider: string): PartFailure => ({
  text: `${provider} couldn't accept your bank transfer and is returning the money to your bank account.`,
  action: START_OVER,
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
  failures: {
    declined: ({ provider }) => notAccepted(provider),
    failed: ({ provider }) => notAccepted(provider),
    // The transfer can still be on its way: a second one does not help.
    expired: ({ provider }) => ({
      text: `We haven't received your bank transfer. If it arrives later, ${provider} returns it to your bank account.`,
      action: CLOSE,
    }),
    unobserved: ({ provider }) => ({
      text: `We can't confirm your bank transfer with ${provider}. Check with your bank before you send the money again.`,
      action: CLOSE,
    }),
    refunded: ({ provider }) => ({
      text: `${provider} couldn't complete your top-up and is returning the money to your bank account.`,
      action: START_OVER,
    }),
  },
});
