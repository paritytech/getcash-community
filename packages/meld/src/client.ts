// The Meld boundary. `MeldClientLike` is the structural interface the rest of the package codes
// against. `createMeldClient` talks to the onramp adapter service, which holds the Meld API key;
// `createFakeMeldClient` is the offline stand-in.

/** Forward-quote request. Meld quotes are source-denominated: the buyer names the fiat they pay
 *  and Meld returns the crypto delivered. `computeMeldQuote` iterates this for a reverse target. */
export interface MeldQuoteRequest {
  /** ISO country of the buyer, e.g. 'US'. */
  country: string;
  /** Fiat the user pays in, e.g. 'USD'. */
  sourceCurrencyCode: string;
  /** Meld destination currency code, e.g. 'USDC_ASSETHUB'. */
  destinationCurrencyCode: string;
  /** Fiat the user pays, whole-currency decimal string (≤2 fraction digits), e.g. '20.00'. */
  sourceAmount: string;
  /** Meld payment-method code, e.g. 'CREDIT_DEBIT_CARD' | 'ACH' | 'SEPA'. */
  paymentMethodType: string;
}

/**
 * Sell-quote request. A sell quote runs the other way round from a buy: it is
 * crypto-denominated. The seller names the crypto they will send (`sourceAmount` in
 * `sourceCurrencyCode`) and the provider answers with the fiat it will deliver. On a buy the
 * buyer names the fiat and the provider answers with the crypto. This is the single most
 * confusing thing about the two directions, and the one to hold on to when reading either path.
 *
 * These names are this package's, chosen so a sell reads source-to-destination like anything
 * else. They are NOT the adapter's: on the wire the crypto leg is `destinationCurrencyCode` in
 * both directions and the crypto amount has a field of its own. See `getSellQuote`.
 */
export interface MeldSellQuoteRequest {
  /** ISO country of the seller, e.g. 'US'. */
  country: string;
  /** The crypto being sold, e.g. 'DOT_ASSETHUB'. */
  sourceCurrencyCode: string;
  /** Crypto the seller sends, whole-token decimal string, e.g. '153.5'. */
  sourceAmount: string;
  /** Fiat the seller is paid in, e.g. 'USD'. */
  destinationCurrencyCode: string;
  /** Meld payout-rail code, e.g. 'ACH' | 'SEPA'. */
  paymentMethodType: string;
}

/** One provider's quote line (Transak, Koywe, ...). Field names are Meld's, verbatim.
 *  Both directions use this shape because the fee components are the same either way; only the
 *  denomination of the two amounts flips. On a buy `sourceAmount` is fiat and
 *  `destinationAmount` is crypto; on a sell `sourceAmount` is crypto and `destinationAmount` is
 *  fiat. */
export interface MeldQuoteEntry {
  readonly serviceProvider: string;
  /** Fiat charged (decimal string). */
  readonly sourceAmount: string;
  /** Crypto delivered for that fiat (decimal string). */
  readonly destinationAmount: string;
  /** The whole fee, and the components it is made of. Meld sends each as its own field; they are
   *  reported verbatim rather than derived, so a component missing from a quote simply is not
   *  shown. Observed on card quotes: `transactionFee + partnerFee === totalFee`, `networkFee`
   *  null. */
  readonly totalFee?: string;
  /** The provider's own fee (Transak's, say). */
  readonly transactionFee?: string;
  /** The chain's own charge for the provider's outgoing transfer to the address it was given —
   *  Meld: "outgoing transactions to external cryptocurrency addresses typically incur a 'mining'
   *  or 'network' fee". It covers the delivery and stops there; nothing the receiver goes on to do
   *  with the funds is in it. */
  readonly networkFee?: string;
  /** Our cut, surfaced to the buyer as the service fee. */
  readonly partnerFee?: string;
  /** Meld's provider ranking; higher is better. Used only to break ties. */
  readonly customerScore?: number;
}

export interface MeldSessionRequest {
  readonly serviceProvider: string;
  readonly country: string;
  readonly sourceCurrencyCode: string;
  readonly sourceAmount: string;
  readonly destinationCurrencyCode: string;
  readonly destinationAmount: string;
  /** The burner's Asset Hub address, where the provider delivers the native token. */
  readonly walletAddress: string;
  readonly paymentMethodType: string;
}

export interface MeldSessionResult {
  /** The adapter's funding-request id. Status polling uses it via `GET /funding/:id`. */
  readonly fundingRequestId: string;
  /** Meld session id. A support handle; it cannot be queried. */
  readonly sessionId: string;
  /** The idempotency key sent on create, echoed on the transaction as its externalSessionId. */
  readonly externalSessionId: string;
  /** The provider-hosted pay page where card or bank details are captured. */
  readonly widgetUrl: string;
  /** Meld's own hosted widget for this session, when returned. The app prefers it for the embed. */
  readonly meldWidgetUrl?: string;
  /**
   * When this session stops being payable, in epoch ms. Absent when the rail published no expiry.
   */
  readonly expiresAt?: number;
}

/**
 * Sell-session request. Meld calls this sessionType SELL. It carries no `walletAddress`: on a
 * sell the provider issues the address and we send to it, the opposite of a buy, where we name
 * the address the provider delivers to. That address arrives later, on the status.
 */
export interface MeldSellSessionRequest {
  readonly serviceProvider: string;
  /**
   * What makes this sale this sale, for the idempotency key. The buy has the burner address to
   * name a purchase with; a sell sends no address, so without this the key would be a pure
   * function of the corridor and two different sales in the same corridor would collide — the
   * second one resuming into the first one's hosted surface, at the first one's amount.
   *
   * Callers pass the withdrawal's burner Asset Hub address: unique per withdrawal and derived
   * from the entropy label, so it survives a reload the way the buy's does.
   *
   * Key material only. It is never sent: the adapter neither needs it nor stores it.
   */
  readonly orderRef: string;
  readonly country: string;
  /** The crypto being sold, e.g. 'DOT_ASSETHUB'. */
  readonly sourceCurrencyCode: string;
  /** The exact crypto amount being committed, whole-token decimal string at full asset
   *  precision. It never travels as `sourceAmount`; see `createSellSession`. */
  readonly sourceAmount: string;
  /** Fiat the seller is paid in, e.g. 'USD'. */
  readonly destinationCurrencyCode: string;
  /** The fiat the quote promised for `sourceAmount`. Carried for the caller's own bookkeeping
   *  and deliberately not sent, exactly as the buy's is not: the adapter re-prices server-side,
   *  and a figure sent only to be overwritten is a figure someone will one day trust. */
  readonly destinationAmount: string;
  /** Meld payout-rail code, e.g. 'ACH' | 'SEPA'. */
  readonly paymentMethodType: string;
}

/**
 * A sell session. Identical in shape to a buy's: the same funding-request id to poll, the same
 * hosted surface, where the seller does KYC and names the bank account to be paid into. It is a
 * type of its own rather than an alias so the two directions stay tellable apart at call sites,
 * and because the sell-only detail it will grow (a payout reference, say) has no buy equivalent.
 * The deposit address is deliberately not here: the provider only issues it after KYC, so it is
 * read back off `getStatus`, not off the create.
 */
export interface MeldSellSessionResult extends MeldSessionResult {}

/**
 * Sell only: where the provider wants the crypto sent, as the adapter last saw it. The adapter
 * learns it by polling Meld — there is no webhook anywhere in this system, in either direction —
 * and discloses it only while its `live` predicate holds (not terminal, not expired, not
 * cancelled). So it appears part-way through a sell, once the seller has finished KYC, and
 * disappears again the moment the request concludes. Both absences are normal.
 */
export interface MeldDepositDisclosure {
  /** Where the seller must send the crypto. The adapter surfaces Meld's
   *  `cryptoDetails.offrampDestinationWalletAddress` here. */
  readonly address: string;
  /** The crypto amount the provider expects, verbatim decimal string at full asset precision.
   *  Sending a different amount is what makes a sell go unmatched, so it is carried as disclosed
   *  rather than re-derived from the quote. */
  readonly amount: string;
  /** The asset that amount is in, Meld's code, e.g. 'DOT_ASSETHUB'. */
  readonly currency: string;
  /** A destination tag or payment reference, for the chains that need one. Usually absent. */
  readonly memo?: string;
  /** When the adapter's poll last saw these terms, in epoch ms. */
  readonly observedAt: number;
}

export interface MeldStatusResult {
  /**
   * The adapter's lifecycle state: `created`, `session_opened`, `transaction_seen`, `settled`,
   * `failed`, `expired`, `refused`, `declined`, `refunded` or `unobserved`.
   */
  readonly status: string;
  /** The provider's own last status verbatim (e.g. Meld `REFUNDED`), for distinctions the coarse
   *  `status` drops. Absent until the rail has reported one. */
  readonly providerStatus?: string;
  /** Where an unfinished purchase can be resumed. Present only while the request is still live. */
  readonly serviceProviderWidgetUrl?: string;
  readonly widgetUrl?: string;
  readonly expiresAt?: number;
  /** The terms the request was opened with. Reported for every row, live or concluded. */
  readonly walletAddress?: string;
  readonly fiat?: string;
  readonly destinationCurrencyCode?: string;
  /** The fiat the row was opened for. Null on a sell, which has no fiat amount until the
   *  provider prices it, so the column is nullable rather than overloaded with a crypto figure. */
  readonly sourceAmount?: string;
  /** Sell only: the crypto the row was opened for, echoed verbatim at full precision. This is
   *  what makes one sale in a corridor tellable from the next when a row is resumed. */
  readonly cryptoAmount?: string;
  /**
   * Sell only: the provider's deposit terms, when the adapter is disclosing them on this poll.
   * Absent means not known or no longer disclosed — never an error, and never a reason to stop
   * polling. It belongs to the poll that returned it: a caller that caches it past its own poll
   * can show a seller an address the adapter has since stopped standing behind.
   */
  readonly deposit?: MeldDepositDisclosure;
}

/** The outcome of asking the adapter to withdraw a request's pay page. */
export type MeldCancelResult =
  | { readonly outcome: "cancelled"; readonly cancelledAt?: number }
  /** A payment is already on its way, or the request has concluded, so it cannot be cancelled. */
  | { readonly outcome: "not-cancellable" }
  /** The adapter does not know this request (unknown id, or it belongs to another caller). */
  | { readonly outcome: "not-found" };

/**
 * The sell (off-ramp) half of the boundary. It is a separate interface because the buy half is
 * older and is implemented in several places by hand — the app's status-capturing wrapper, the
 * test doubles — none of which sell. `MeldClientLike` therefore picks it up optionally, while the
 * concrete clients here return it in full, so code holding a real client gets both directions
 * without a presence check and code holding any `MeldClientLike` has to ask.
 *
 * There is no `getSellStatus`: a sell is polled on the same `GET /funding/:id` as a buy, and
 * `getStatus` serves both.
 */
export interface MeldSellClientLike {
  getSellQuote(req: MeldSellQuoteRequest): Promise<{ quotes: MeldQuoteEntry[] }>;
  createSellSession(req: MeldSellSessionRequest): Promise<MeldSellSessionResult>;
}

export interface MeldClientLike extends Partial<MeldSellClientLike> {
  getQuote(req: MeldQuoteRequest): Promise<{ quotes: MeldQuoteEntry[] }>;
  createSession(req: MeldSessionRequest): Promise<MeldSessionResult>;
  getStatus(fundingRequestId: string): Promise<MeldStatusResult>;
  /** Withdraws the pay page for a request. Never a hard failure for the normal refusals. */
  cancel(fundingRequestId: string): Promise<MeldCancelResult>;
}

export interface MeldEndpointConfig {
  /** Base URL of the onramp adapter service, e.g. '/api/meld'. */
  baseUrl: string;
  /** Sent as `x-dev-product-id` for the adapter's dev auth. */
  productId?: string;
  /** Idempotency key per session create. Defaults to a key derived from the purchase intent. */
  idempotencyKey?: () => string;
  /** Where the embedded widget lands the buyer on completion; forwarded to Meld's redirectUrl. */
  redirectUrl?: string;
  /** Injectable fetch (tests / non-browser). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** The detail the adapter attached to a tag: a threshold on BelowMinimum/AboveMaximum, or its own
 *  `{ code, message }` on the catch-all `Other`. */
interface TagValue {
  amount?: string;
  currency?: string;
  code?: string;
  message?: string;
  /** On a 409 for an existing request: the id of that request. */
  fundingRequestId?: string;
}

/** Buyer-facing copy for each adapter failure tag. Unknown tags fall back to a generic line naming
 *  the failed call, `what`. */
function messageForTag(tag: string, value?: TagValue, what?: string): string {
  switch (tag) {
    case "NoQuotesAvailable":
      return "Not available for this payment method or region. Try another method.";
    case "RegionUnavailable":
      return "Not available in your region yet.";
    case "BelowMinimum":
      return value
        ? `Below the minimum. The minimum is ${value.amount} ${value.currency}.`
        : "That amount is below the minimum.";
    case "AboveMaximum":
      return value
        ? `Above the maximum. The maximum is ${value.amount} ${value.currency}.`
        : "That amount is above the maximum.";
    case "WrongAssetOrChain":
      return "That asset isn't supported.";
    case "RouteWithdrawn":
      return "This payment route is temporarily unavailable.";
    case "ProviderTimeout":
      return "Couldn't reach the payment provider. Please try again.";
    case "Other":
      // The adapter's catch-all. Carry its own code and message through.
      return value?.code
        ? `${value.message ?? "The payment service refused the request."} (${value.code})`
        : (value?.message ?? "The payment service refused the request. Please try again.");
    default:
      return `${what ?? "The payment"} failed (${tag}). Please try again.`;
  }
}

/** An adapter refusal: the buyer-facing message plus the adapter's code and the request id. */
class AdapterRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly fundingRequestId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AdapterRefusal";
  }
}

/** How many concluded attempts a session create walks past before giving up. */
const MAX_ATTEMPTS = 5;

/**
 * Everything a session create needs that differs between the two directions. The attempt-walk
 * around the idempotency key — resume a live row, tolerate a lapsed surface, step past a
 * concluded one, stop at a countable number of steps — is the same for a buy and a sell, and it
 * is the part that must not drift between them: two copies of it is two chances to lose a
 * payment. So the walk is written once and the direction supplies its route, its body, the terms
 * a resumed row is checked against and its own wording.
 */
interface SessionWalk {
  /** Adapter route, relative to the base URL. */
  readonly path: string;
  /** Names the failing call in the buyer- or seller-facing refusal copy. */
  readonly what: string;
  /** The per-attempt default idempotency key. Bypassed by a caller-supplied key. */
  readonly key: (attempt: number) => string;
  /** The create body, minus the key, which the walk adds. */
  readonly body: () => Record<string, unknown>;
  /**
   * The terms a resumed row must agree with, as `[label, stored, asked]`. A row that disagrees is
   * somebody else's order and is refused rather than resumed into.
   */
  readonly terms: (
    found: MeldStatusResult,
  ) => readonly (readonly [string, string | undefined, string])[];
  /**
   * The amount just quoted, compared against the resumed row's stored `sourceAmount`. A
   * difference only logs: on a buy the row is still the right purchase, the rate has just moved
   * under it. Omitted by a direction whose row does not store a comparable figure, which is the
   * only honest way to skip a check — a comparison against a field that is never populated
   * either fires every time or passes for the wrong reason.
   */
  readonly askedAmount?: string;
  /** Refusal copy when a resumed row is for a different order. */
  readonly mismatchMessage: string;
  /** Refusal copy when the row the adapter named has no surface left to continue on. */
  readonly reopenedMessage: string;
  /** Developer-facing complaint when the adapter opened a request with no hosted surface. */
  readonly noSurfaceMessage: (fundingRequestId: string) => string;
  /** Refusal copy when every attempt the walk can name has already concluded. */
  readonly exhaustedMessage: string;
}

/**
 * Normalizes an adapter quote list to decimal strings, dropping offers with no serviceProvider.
 * Shared by both directions: the fee components and their quirks are the same either way, only
 * the denomination of the two amounts flips.
 */
function toQuoteEntries(raw: Record<string, unknown>[]): MeldQuoteEntry[] {
  return raw
    .filter((q) => q.serviceProvider != null && String(q.serviceProvider) !== "")
    .map((q) => ({
      serviceProvider: String(q.serviceProvider),
      sourceAmount: String(q.sourceAmount ?? ""),
      destinationAmount: String(q.destinationAmount ?? ""),
      ...(q.totalFee != null ? { totalFee: String(q.totalFee) } : {}),
      ...(q.transactionFee != null ? { transactionFee: String(q.transactionFee) } : {}),
      ...(q.networkFee != null ? { networkFee: String(q.networkFee) } : {}),
      ...(q.partnerFee != null ? { partnerFee: String(q.partnerFee) } : {}),
      // Meld returns customerScore as a string. Coerce it and keep it only when finite.
      ...((): { customerScore?: number } => {
        // A blank score is unscored, not 0.
        const text = typeof q.customerScore === "string" ? q.customerScore.trim() : q.customerScore;
        const cs = Number(text);
        return text != null && text !== "" && Number.isFinite(cs) ? { customerScore: cs } : {};
      })(),
    }));
}

/**
 * Builds a MeldClientLike over the Meld adapter service, which holds the Meld key and adds the
 * Meld auth headers server-side. This side speaks the adapter's JSON routes: `POST /quote`,
 * `POST /session` and `GET /funding/:fundingRequestId`. Both directions ride the same three: the
 * sell adds an optional `direction: "sell"` to the two bodies, the way `rail` already
 * discriminates on them, and absent means buy. A sibling `/sell/*` route would have forked the
 * reserve-before-call ordering and the conclusion codes that `POST /session` carries, which is
 * the machinery least able to afford a second copy.
 *
 * Nothing here is pushed. The adapter learns Meld's outcomes by polling Meld and this learns the
 * adapter's by polling `GET /funding/:id`; there is no webhook receipt path at any hop.
 */
export function createMeldClient(config: MeldEndpointConfig): MeldClientLike & MeldSellClientLike {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/$/, "");
  /**
   * The default idempotency key: the terms the buyer chose, plus an attempt counter. No solved
   * amount or provider is included.
   */
  const intentKey = (req: MeldSessionRequest, attempt: number) =>
    [
      "getcash",
      req.walletAddress,
      req.sourceCurrencyCode,
      req.destinationCurrencyCode,
      req.paymentMethodType,
      req.country,
      attempt,
    ].join("-");
  /**
   * The same, for a sell. `sell` is in the key because a buy and a sell of the same pair in the
   * same country are two different intents and must never land on one another's request; without
   * the marker `USD`/`DOT_ASSETHUB` in one order or the other could collide. `orderRef` sits
   * where the buy puts its burner address, and for the same two reasons: it makes one sale
   * distinguishable from the next in the same corridor, and it keeps the attempt counter a retry
   * escape hatch rather than a lifetime limit on how many times this corridor can ever be sold
   * through.
   */
  const sellIntentKey = (req: MeldSellSessionRequest, attempt: number) =>
    [
      "getcash",
      "sell",
      req.orderRef,
      req.sourceCurrencyCode,
      req.destinationCurrencyCode,
      req.paymentMethodType,
      req.country,
      attempt,
    ].join("-");
  const nextKey = config.idempotencyKey;

  const headers = (): Record<string, string> => ({
    accept: "application/json",
    ...(config.productId ? { "x-dev-product-id": config.productId } : {}),
  });

  /**
   * Parses the adapter's JSON body. On a non-OK response, maps `{ error: { tag, value } }` to an
   * AdapterRefusal with a buyer-facing message.
   */
  async function read(res: Response, what: string): Promise<Record<string, unknown>> {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = data["error"] as { tag?: string; value?: TagValue } | string | undefined;
      const tag = typeof err === "string" ? err : (err?.tag ?? String(res.status));
      const value = typeof err === "string" ? undefined : err?.value;
      console.warn(
        `[meld] ${what} failed: ${res.status} ${tag}${value ? ` ${JSON.stringify(value)}` : ""}`,
      );
      throw new AdapterRefusal(
        messageForTag(tag, value, what),
        res.status,
        typeof value === "object" && value !== null && "code" in value
          ? String(value.code)
          : undefined,
        typeof value?.fundingRequestId === "string" ? value.fundingRequestId : undefined,
      );
    }
    return data;
  }

  async function post(path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return read(res, what);
  }

  /** Fetches `GET /funding/:id` and maps the adapter's funding record onto MeldStatusResult. */
  async function getFundingStatus(fundingRequestId: string): Promise<MeldStatusResult> {
    const res = await doFetch(`${base}/funding/${encodeURIComponent(fundingRequestId)}`, {
      headers: headers(),
    });
    const data = await read(res, "the payment status");
    const funding = (data.funding as Record<string, unknown> | undefined) ?? {};
    return {
      status: String(funding.status ?? ""),
      ...(funding.providerStatus != null ? { providerStatus: String(funding.providerStatus) } : {}),
      // Present only while the purchase is still payable.
      ...(funding.serviceProviderWidgetUrl != null
        ? { serviceProviderWidgetUrl: String(funding.serviceProviderWidgetUrl) }
        : {}),
      ...(funding.widgetUrl != null ? { widgetUrl: String(funding.widgetUrl) } : {}),
      ...(typeof funding.expiresAt === "number" ? { expiresAt: funding.expiresAt } : {}),
      // The terms the row was opened with. Reported for concluded rows too.
      ...(funding.walletAddress != null ? { walletAddress: String(funding.walletAddress) } : {}),
      ...(funding.fiat != null ? { fiat: String(funding.fiat) } : {}),
      ...(funding.destinationCurrencyCode != null
        ? { destinationCurrencyCode: String(funding.destinationCurrencyCode) }
        : {}),
      ...(funding.sourceAmount != null ? { sourceAmount: String(funding.sourceAmount) } : {}),
      ...(funding.cryptoAmount != null ? { cryptoAmount: String(funding.cryptoAmount) } : {}),
      // Sell only, and only on the polls the adapter chooses to disclose it: after the seller's
      // KYC, and only while the request is live.
      //
      // All four required parts or nothing. A seller cannot act on half a disclosure, and each
      // half-formed version of it is worse than none: an empty address is somewhere to send real
      // funds to, an empty currency reads as an asset, and an `observedAt` filled in here would
      // make an arbitrarily stale address look like it was seen this instant — a lie in the one
      // field whose whole job is to let a caller judge freshness. The adapter is ours and always
      // sends all four, so anything less is a fault, and the safe reading of a fault is that
      // nothing was disclosed.
      ...((): { deposit?: MeldDepositDisclosure } => {
        const deposit = funding.deposit as Record<string, unknown> | undefined;
        if (deposit == null) return {};
        const text = (v: unknown) => (v == null ? "" : String(v));
        const [address, amount, currency] = [
          text(deposit.address),
          text(deposit.amount),
          text(deposit.currency),
        ];
        if (!address || !amount || !currency) return {};
        if (typeof deposit.observedAt !== "number") return {};
        return {
          deposit: {
            address,
            amount,
            currency,
            ...(deposit.memo != null ? { memo: String(deposit.memo) } : {}),
            observedAt: deposit.observedAt,
          },
        };
      })(),
    };
  }

  /**
   * Re-attaches to an existing funding request. Returns null when the adapter withholds the
   * hosted surface (the row concluded or its surface closed). Throws when a term the direction
   * names differs from the request; a differing `sourceAmount` only logs.
   */
  async function resume(
    walk: SessionWalk,
    fundingRequestId: string,
    externalSessionId: string,
  ): Promise<MeldSessionResult | null> {
    const status = await getFundingStatus(fundingRequestId);
    if (!status.serviceProviderWidgetUrl) return null;
    const mismatched = walk
      .terms(status)
      .filter(([, stored, asked]) => stored !== undefined && stored !== asked);
    if (mismatched.length > 0) {
      // The row is for a different order. Do not resume into it or open a new session.
      throw new AdapterRefusal(
        walk.mismatchMessage,
        409,
        "RESUMED_REQUEST_MISMATCH",
        fundingRequestId,
      );
    }
    if (
      walk.askedAmount !== undefined &&
      status.sourceAmount !== undefined &&
      status.sourceAmount !== walk.askedAmount
    ) {
      console.warn(
        `[meld] resuming ${fundingRequestId} priced at ${status.sourceAmount} ${status.fiat ?? ""}, not the ${walk.askedAmount} just quoted; the rate moved since it was opened`,
      );
    }
    return {
      fundingRequestId,
      // Meld's session id is not on the funding record.
      sessionId: "",
      externalSessionId,
      widgetUrl: status.serviceProviderWidgetUrl,
      ...(status.widgetUrl ? { meldWidgetUrl: status.widgetUrl } : {}),
      ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
    };
  }

  /**
   * Opens a session, walking the attempt forward past concluded ones only. A caller-supplied key
   * is used verbatim and never walked. `REQUEST_OUTCOME_UNKNOWN`, `REQUEST_IN_FLIGHT` and
   * `REQUEST_ALREADY_SETTLED` are rethrown: none of them rules out that money moved, and minting
   * a fresh key on any of them would open a second request against the same intent.
   */
  async function openSession(walk: SessionWalk): Promise<MeldSessionResult> {
    let lastRefusal: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const externalSessionId = nextKey?.() ?? walk.key(attempt);
      try {
        const data = await post(
          walk.path,
          { idempotencyKey: externalSessionId, ...walk.body() },
          walk.what,
        );
        const fundingRequestId = String(data.fundingRequestId ?? "");
        if (!fundingRequestId) {
          throw new Error(
            "[meld] the adapter returned no fundingRequestId; status could not be polled",
          );
        }
        const widgetUrl = String(data.serviceProviderWidgetUrl ?? "");
        const meldWidgetUrl = data.widgetUrl != null ? String(data.widgetUrl) : undefined;
        if (!widgetUrl && !meldWidgetUrl) throw new Error(walk.noSurfaceMessage(fundingRequestId));
        return {
          fundingRequestId,
          sessionId: String(data.sessionId ?? ""),
          externalSessionId,
          widgetUrl,
          ...(meldWidgetUrl !== undefined ? { meldWidgetUrl } : {}),
          ...(typeof data.expiresAt === "number" ? { expiresAt: data.expiresAt } : {}),
        };
      } catch (err) {
        // `IDEMPOTENCY_KEY_REUSED` names a live request opened under this key. Resume it.
        if (
          err instanceof AdapterRefusal &&
          err.status === 409 &&
          err.code === "IDEMPOTENCY_KEY_REUSED" &&
          err.fundingRequestId !== undefined
        ) {
          const resumed = await resume(walk, err.fundingRequestId, externalSessionId);
          if (resumed) return resumed;
          // The row exists but has no surface left: it concluded or its hosted page closed.
          throw new AdapterRefusal(
            walk.reopenedMessage,
            err.status,
            err.code,
            err.fundingRequestId,
            { cause: err },
          );
        }
        // `REQUEST_SURFACE_EXPIRED`: the hosted page lapsed but the row is live. Return a
        // surface-less result and let status polling conclude it.
        if (
          err instanceof AdapterRefusal &&
          err.status === 409 &&
          err.code === "REQUEST_SURFACE_EXPIRED" &&
          err.fundingRequestId !== undefined
        ) {
          return {
            fundingRequestId: err.fundingRequestId,
            sessionId: "",
            externalSessionId,
            widgetUrl: "",
          };
        }
        const concluded =
          err instanceof AdapterRefusal && err.status === 409 && err.code === "REQUEST_CONCLUDED";
        if (!concluded || nextKey) throw err;
        console.info(`[meld] attempt ${attempt} already concluded; starting a new one`);
        lastRefusal = err;
      }
    }
    // Every attempt this walk can name has already concluded.
    throw new Error(
      walk.exhaustedMessage,
      lastRefusal instanceof Error ? { cause: lastRefusal } : undefined,
    );
  }

  return {
    async getQuote(req) {
      const data = await post(
        "/quote",
        {
          country: req.country,
          fiat: req.sourceCurrencyCode, // the adapter names the fiat `fiat`
          destinationCurrencyCode: req.destinationCurrencyCode,
          sourceAmount: req.sourceAmount, // Meld's quote is source-denominated (forward)
          paymentMethodType: req.paymentMethodType,
        },
        "The quote",
      );
      const raw = (data.quotes as Record<string, unknown>[] | undefined) ?? [];
      return { quotes: toQuoteEntries(raw) };
    },

    async getSellQuote(req) {
      // Crypto-denominated, the reverse of `getQuote`: the seller names the crypto and the
      // provider answers with the fiat. Same route as the buy, discriminated by `direction`.
      const data = await post(
        "/quote",
        {
          direction: "sell", // absent means buy, so only this side sends it
          country: req.country,
          fiat: req.destinationCurrencyCode, // the fiat leg is `fiat` in both directions
          // Yes, `destinationCurrencyCode` for the asset being SOLD. It reads like a bug and is
          // not one: the adapter's vocabulary is Meld's, one naming across the whole surface,
          // rather than a translation layer that can be wrong in one direction only. The crypto
          // leg is `destinationCurrencyCode` whichever way the trade runs.
          destinationCurrencyCode: req.sourceCurrencyCode,
          // Not `sourceAmount`: that field is validated as fiat minor units, two decimals at
          // most, and DOT has ten. A crypto amount put there is silently truncated, which is
          // precisely the loss the exact-amount design exists to prevent.
          cryptoAmount: req.sourceAmount,
          paymentMethodType: req.paymentMethodType,
        },
        "The quote",
      );
      const raw = (data.quotes as Record<string, unknown>[] | undefined) ?? [];
      return { quotes: toQuoteEntries(raw) };
    },
    async createSession(req) {
      return openSession({
        path: "/session",
        what: "Starting the payment",
        key: (attempt) => intentKey(req, attempt),
        body: () => ({
          country: req.country,
          fiat: req.sourceCurrencyCode,
          destinationCurrencyCode: req.destinationCurrencyCode,
          sourceAmount: req.sourceAmount,
          walletAddress: req.walletAddress,
          paymentMethodType: req.paymentMethodType,
          // Required by the adapter, sent unconditionally.
          serviceProvider: req.serviceProvider,
          ...(config.redirectUrl ? { redirectUrl: config.redirectUrl } : {}),
        }),
        // The burner is what makes a buy this buy: a row against another address is another order.
        terms: (found) => [
          ["walletAddress", found.walletAddress, req.walletAddress],
          ["fiat", found.fiat, req.sourceCurrencyCode],
          ["destinationCurrencyCode", found.destinationCurrencyCode, req.destinationCurrencyCode],
        ],
        askedAmount: req.sourceAmount,
        mismatchMessage:
          "We found a payment for a different order. Contact support before starting another.",
        reopenedMessage:
          "This purchase is already open and can no longer be paid here. Contact support with your reference. Do not start another.",
        noSurfaceMessage: (fundingRequestId) =>
          `[meld] the adapter returned no pay page for funding request ${fundingRequestId}; there is nothing for the buyer to pay on`,
        exhaustedMessage: `This purchase has already been completed ${MAX_ATTEMPTS} times. If you are expecting funds that have not arrived, contact support with your wallet address. Starting another will not help.`,
      });
    },

    async createSellSession(req) {
      // The mirror of `createSession`, on the same route, discriminated by `direction`: it walks
      // the same attempts, resumes the same way and is refused with the same codes. No
      // `walletAddress` goes out, because the provider issues the deposit address and it comes
      // back later on the status, once KYC is done.
      return openSession({
        path: "/session",
        what: "Starting the sale",
        key: (attempt) => sellIntentKey(req, attempt),
        body: () => ({
          direction: "sell", // absent means buy, so only this side sends it
          country: req.country,
          fiat: req.destinationCurrencyCode, // the fiat leg is `fiat` in both directions
          // The crypto leg, named `destinationCurrencyCode` even though it is what the seller
          // sends. Meld's vocabulary, kept across the whole surface; see `getSellQuote`.
          destinationCurrencyCode: req.sourceCurrencyCode,
          // The committed amount, at full asset precision. `sourceAmount` would truncate it to
          // two decimals; see `getSellQuote`. `destinationAmount` is not sent at all, as on the
          // buy: the adapter re-prices server-side.
          cryptoAmount: req.sourceAmount,
          paymentMethodType: req.paymentMethodType,
          // Required by the adapter, sent unconditionally.
          serviceProvider: req.serviceProvider,
          ...(config.redirectUrl ? { redirectUrl: config.redirectUrl } : {}),
        }),
        // The funding record names the fiat leg `fiat` and the crypto leg
        // `destinationCurrencyCode` whichever way the trade ran, so the sell compares them the
        // other way round from the buy.
        //
        // The committed amount is a hard term here, where on the buy it is only a warning. A buy
        // resumed at a different fiat figure is the same purchase at a moved rate. A sell
        // resumed at a different crypto figure is a seller about to send an amount they did not
        // agree to — there is no address to catch it on, so this comparison is the only thing
        // standing between backing out of a 100 DOT sale and being handed its surface while
        // believing you are selling 50.
        terms: (found) => [
          ["fiat", found.fiat, req.destinationCurrencyCode],
          ["crypto", found.destinationCurrencyCode, req.sourceCurrencyCode],
          ["cryptoAmount", found.cryptoAmount, req.sourceAmount],
        ],
        // No price-drift check: a sell's row carries no `sourceAmount` to compare against, and
        // the committed crypto is covered above as a hard term.
        mismatchMessage:
          "We found a sale for a different order. Contact support before starting another.",
        reopenedMessage:
          "This sale is already open and can no longer be continued here. Contact support with your reference. Do not start another.",
        noSurfaceMessage: (fundingRequestId) =>
          `[meld] the adapter returned no hosted page for funding request ${fundingRequestId}; there is nothing for the seller to continue on`,
        exhaustedMessage: `This sale has already been completed ${MAX_ATTEMPTS} times. If you have sent funds and have not been paid, contact support. Starting another will not help.`,
      });
    },

    getStatus: getFundingStatus,

    async cancel(fundingRequestId): Promise<MeldCancelResult> {
      try {
        const data = await post(
          `/funding/${encodeURIComponent(fundingRequestId)}/cancel`,
          {},
          "The cancel",
        );
        const funding = (data.funding as Record<string, unknown> | undefined) ?? {};
        return {
          outcome: "cancelled",
          ...(typeof funding.cancelledAt === "number" ? { cancelledAt: funding.cancelledAt } : {}),
        };
      } catch (err) {
        // A payment already in flight (or a concluded request) is a deliberate refusal, not a
        // fault: the buyer must not be told it is cancelled while their money is moving.
        if (
          err instanceof AdapterRefusal &&
          err.status === 409 &&
          err.code === "REQUEST_NOT_CANCELLABLE"
        )
          return { outcome: "not-cancellable" };
        // The adapter has no such request (unknown id, or another caller's). Nothing to withdraw.
        if (err instanceof AdapterRefusal && err.status === 404) return { outcome: "not-found" };
        throw err;
      }
    },
  };
}
