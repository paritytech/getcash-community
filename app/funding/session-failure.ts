// What a card or bank buy, or a sale, says when its session could not be opened. The adapter's
// codes are never shown: each is worded here, and anything unrecognised reads as our failure.

import { refusalOf } from "@getsome/meld";
import { reportFailure } from "~~/lib/telemetry";
import { failureCauseOf, railFailureReason } from "./quote-failure";

export interface SessionFailureContext {
  readonly side: "buy" | "sell";
  readonly method: "card" | "bank";
  /** The payment country's name. */
  readonly country: string;
}

/** What the report adds to the words: the quote's provider, when there is one. */
export interface SessionFailureReport extends SessionFailureContext {
  readonly provider?: string | null;
}

type Wording = (context: SessionFailureContext) => string;

/** Refusals the Meld client already words for the person. */
const CLIENT_WORDED = new Set([
  "NoQuotesAvailable",
  "BelowMinimum",
  "AboveMaximum",
  "RegionUnavailable",
  "WrongAssetOrChain",
  "IDEMPOTENCY_KEY_REUSED",
  "RESUMED_REQUEST_MISMATCH",
  "ATTEMPTS_EXHAUSTED",
]);

const BUY_METHOD = { card: "card", bank: "bank transfer" } as const;
const SELL_DESTINATION = { card: "card", bank: "bank account" } as const;

const untouched: Wording = ({ side }) =>
  side === "buy" ? "You haven't been charged." : "Your Cash is still in your balance.";

const way: Wording = ({ side, method }) =>
  side === "buy"
    ? `Paying by ${BUY_METHOD[method]}`
    : `Paying out to your ${SELL_DESTINATION[method]}`;

const notOffered: Wording = (c) =>
  `${way(c)} isn't available in ${c.country} yet. Try another method.`;
const unavailable: Wording = (c) => `${way(c)} isn't available right now. Try another method.`;
const unreachable: Wording = (c) =>
  `We couldn't reach the payment service. Check your connection and try again. ${untouched(c)}`;
const ourSide: Wording = (c) =>
  `Something went wrong on our side. Try again in a moment. ${untouched(c)}`;

/** Keyed by the adapter's `Other` code, or by its tag where it has no code. */
const WORDING = new Map<string, Wording>([
  [
    "PROVIDER_REJECTED",
    (c) =>
      `The provider rejected this quote. ${untouched(c)} Try again later or use another method.`,
  ],
  [
    "AMOUNT_REJECTED",
    (c) =>
      c.side === "buy"
        ? `The provider can't take this amount by ${BUY_METHOD[c.method]} in ${c.country}. Try a different amount. ${untouched(c)}`
        : `The provider can't take this amount. Try a different amount. ${untouched(c)}`,
  ],
  ["PAYMENT_METHOD_UNSUPPORTED", notOffered],
  ["CURRENCY_UNSUPPORTED", notOffered],
  ["CORRIDOR_UNAVAILABLE", unavailable],
  ["UNKNOWN_RAIL", unavailable],
  ["DIRECTION_UNSUPPORTED", unavailable],
  ["RAIL_REFUSED", unavailable],
  ["RouteWithdrawn", unavailable],
  ["RATE_LIMITED", () => "Too many attempts. Wait a minute, then try again."],
  [
    "REQUEST_IN_FLIGHT",
    ({ side }) =>
      `Your ${side === "buy" ? "payment" : "sale"} is still being set up. Try again later.`,
  ],
  [
    "REQUEST_OUTCOME_UNKNOWN",
    ({ side, method }) => {
      if (side === "sell") {
        return "We can't confirm whether your last sale went through. Check your balance before you try again.";
      }
      const check =
        method === "card"
          ? "Check your card statement before you pay again."
          : "Check with your bank before you send money again.";
      return `We can't confirm whether your last payment went through. ${check}`;
    },
  ],
  [
    "REQUEST_ALREADY_SETTLED",
    ({ side }) =>
      side === "buy"
        ? "This payment already went through. Don't pay again. You'll find it in your top-ups."
        : "This sale already went through. Don't start it again.",
  ],
  ["ProviderTimeout", unreachable],
]);

export function sessionFailureText(error: unknown, context: SessionFailureContext): string {
  if (!(error instanceof Error)) return ourSide(context);
  const refusal = refusalOf(error);
  if (refusal === undefined) {
    const offline = error instanceof TypeError || error.name === "TimeoutError";
    return (offline ? unreachable : ourSide)(context);
  }
  const key = refusal.code ?? refusal.tag;
  if (key !== undefined && CLIENT_WORDED.has(key)) return error.message;
  const wording = key === undefined ? undefined : WORDING.get(key);
  if (wording !== undefined) return wording(context);
  // A body that is not the adapter's, from a gateway in front of it.
  return (refusal.status >= 502 ? unreachable : ourSide)(context);
}

/** Reports a session that could not be opened, and returns what the screen says. */
export function sessionFailed(error: unknown, report: SessionFailureReport): string {
  const { side, method, country, provider } = report;
  const refusal = refusalOf(error);
  reportFailure("session-failed", {
    reason: railFailureReason(side === "buy" ? method : `sale-${method}`, failureCauseOf(error)),
    error,
    context: {
      country,
      ...(provider ? { provider } : {}),
      ...(refusal === undefined ? {} : { status: String(refusal.status) }),
      ...(refusal?.requestId === undefined ? {} : { requestId: refusal.requestId }),
    },
  });
  return sessionFailureText(error, report);
}
