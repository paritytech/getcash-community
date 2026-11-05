/**
 * WHAT GETCASH MEASURES AND REPORTS: the journey and step names, the failure
 * kinds and which of them are the person's own "no", the screens, the
 * actions and the app's scope tags. The rest of lib/telemetry is the
 * machinery; what feeds the request journeys is app/funding/requests/telemetry.ts.
 *
 * No name or value here may contain auth, secret, credential or password:
 * Sentry's org-level masking blanks the whole value (catalogue.test.ts).
 */

export const JOURNEYS = {
  /** From boot to the first usable screen: the stored requests read, and
   *  the host's network grant answered. */
  "app-open": {
    steps: ["records", "host.permissions"],
    outcomes: ["ready", "browser"],
    stuckMs: 20_000,
    // the host's Remote prompt
    waitSteps: ["host.permissions"],
  },
  /** One top-up started on this page, from its request to the Cash in the
   *  purse. A request resumed from an earlier open has no journey; its
   *  failures are still reported. */
  "top-up": {
    steps: ["deposit", "arrive", "convert", "recover", "claim", "retry"],
    outcomes: ["settled", "failed", "expired", "cancelled"],
    // the swap, the mint and the claim are the app's to move
    stuckMs: 300_000,
    // the person pays or sends the deposit; the provider confirms it and
    // carries it to the account (a BTC deposit's confirmations take a while);
    // a recovery waits on their fee or deposit; a recoverable failure waits on
    // their Try again
    waitSteps: ["deposit", "arrive", "recover", "retry"],
  },
  /** One withdrawal started on this page, from its request to the funds sent. */
  withdraw: {
    steps: ["payment", "convert", "send", "retry"],
    outcomes: ["sent", "failed", "expired", "cancelled"],
    // the host's payment sheet, and a recoverable failure's Try again
    waitSteps: ["payment", "retry"],
  },
} as const;

export type JourneyName = keyof typeof JOURNEYS;

export const FAILURE_KINDS = [
  // the host cannot run this build (useHostGate)
  "host-unsupported",
  "permission-refused",
  // the worker would not take a request
  "handoff-failed",
  // a request's record could not be stored on the host
  "storage-failed",
  // the purse balance could not be read
  "purse-unreadable",
  // a top-up or withdrawal ended failed; the reason is its failure kind
  "top-up-failed",
  "withdraw-failed",
  // the person declined, or could not cover, a host payment
  "payment-refused",
  // a top-up or a sale could not be priced; the reason is `<rail>:<why>`
  // (app/funding/quote-failure.ts)
  "quote-failed",
  // a card or bank buy, or a sale, could not open its session; the reason is `<rail>:<why>`
  // (app/funding/session-failure.ts)
  "session-failed",
  // sent by the core itself: a journey past its stuckMs (journeys.ts)
  "stuck",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * The person's (or their device's) own answer, not our failure: sent as a
 * warning and left out of the failure rate.
 */
export function isExpected(kind: FailureKind, reason: string): boolean {
  switch (kind) {
    case "host-unsupported":
    case "permission-refused":
    case "payment-refused":
      return true;
    case "top-up-failed":
      // the provider refunded the deposit: its decision, the money is back
      return reason === "refunded";
    case "quote-failed":
      // the device was offline, or no provider serves the person's region or method
      return /:(offline|no-provider|unrouted)$/.test(reason);
    case "session-failed":
      // the device was offline, the provider said no, or the person retried too fast
      return /:(offline|provider_rejected|amount_rejected|payment_method_unsupported|currency_unsupported|rate_limited)$/.test(
        reason,
      );
    default:
      return false;
  }
}

/** The screens a person can be on (useScreen): time on each, and how it ran. */
export const SCREENS = [
  "top-up.amount",
  "top-up.pending",
  "top-up.history",
  "top-up.card",
  "top-up.card.widget",
  "top-up.bank",
  "top-up.network",
  "top-up.token",
  "top-up.deposit",
  "top-up.cancel",
  "top-up.journey",
  "top-up.settled",
  "top-up.refund",
  "top-up.recover-deposit",
  // a top-up whose CASH is in People's trap: the fee's confirmation, the token, the deposit
  "top-up.recover-fee",
  "top-up.recover-token",
  "top-up.recover-trapped",
  "withdraw.amount",
  "withdraw.pending",
  "withdraw.history",
  "withdraw.network",
  "withdraw.token",
  "withdraw.address",
  "withdraw.summary",
  "withdraw.sale",
  "withdraw.kyc",
  "withdraw.cancel",
  "withdraw.journey",
  "withdraw.return-funds",
  "fees",
  "region",
] as const;

export type ScreenName = (typeof SCREENS)[number];

/** What a person can do, counted as `ui.action` (actions.ts). */
export const ACTIONS = [
  "amount.continue",
  "route.pick",
  "history.open",
  "card.pay",
  "network.pick",
  "token.pick",
  "deposit.copy",
  "top-up.cancel",
  "top-up.retry",
  "recover.from-balance",
  "withdraw.confirm",
  "withdraw.retry",
  "withdraw.cancel",
  "sale.continue",
  "sale.cancel",
] as const;

export type ActionName = (typeof ACTIONS)[number];

/** The app's own scope tags, on every event and span once set. */
export const APP_TAGS = [
  // the request on screen (its ref key, `<source>#<trade>`), so an error names it
  "request.key",
] as const;

export type AppTag = (typeof APP_TAGS)[number];
