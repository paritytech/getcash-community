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

/** One provider's quote line (Transak, Koywe, ...). Field names are Meld's, verbatim. */
export interface MeldQuoteEntry {
  readonly serviceProvider: string;
  /** Fiat charged (decimal string). */
  readonly sourceAmount: string;
  /** Crypto delivered for that fiat (decimal string). */
  readonly destinationAmount: string;
  readonly totalFee?: string;
  readonly networkFee?: string;
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

export interface MeldStatusResult {
  /**
   * The adapter's lifecycle state: `created`, `session_opened`, `transaction_seen`, `settled`,
   * `failed`, `expired`, `refused` or `unobserved`.
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
  readonly sourceAmount?: string;
}

/** The outcome of asking the adapter to withdraw a request's pay page. */
export type MeldCancelResult =
  | { readonly outcome: "cancelled"; readonly cancelledAt?: number }
  /** A payment is already on its way, or the request has concluded, so it cannot be cancelled. */
  | { readonly outcome: "not-cancellable" }
  /** The adapter does not know this request (unknown id, or it belongs to another caller). */
  | { readonly outcome: "not-found" };

export interface MeldClientLike {
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

/** How many concluded attempts `createSession` walks past before giving up. */
const MAX_ATTEMPTS = 5;

/**
 * Builds a MeldClientLike over the Meld adapter service, which holds the Meld key and adds the
 * Meld auth headers server-side. This side speaks the adapter's JSON routes: `POST /quote`,
 * `POST /session` and `GET /funding/:fundingRequestId`.
 */
export function createMeldClient(config: MeldEndpointConfig): MeldClientLike {
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
    };
  }

  /**
   * Re-attaches to an existing funding request. Returns null when the adapter withholds the pay
   * page (the row concluded or its surface closed). Throws when the stored wallet, fiat or
   * destination asset differs from the request; a differing `sourceAmount` only logs.
   */
  async function resume(
    fundingRequestId: string,
    externalSessionId: string,
    req: MeldSessionRequest,
  ): Promise<MeldSessionResult | null> {
    const status = await getFundingStatus(fundingRequestId);
    if (!status.serviceProviderWidgetUrl) return null;
    const mismatched = (
      [
        ["walletAddress", status.walletAddress, req.walletAddress],
        ["fiat", status.fiat, req.sourceCurrencyCode],
        ["destinationCurrencyCode", status.destinationCurrencyCode, req.destinationCurrencyCode],
      ] as const
    ).filter(([, stored, asked]) => stored !== undefined && stored !== asked);
    if (mismatched.length > 0) {
      // The row is for a different purchase. Do not resume into it or open a new session.
      throw new AdapterRefusal(
        "We found a payment for a different order. Contact support before starting another.",
        409,
        "RESUMED_REQUEST_MISMATCH",
        fundingRequestId,
      );
    }
    if (status.sourceAmount !== undefined && status.sourceAmount !== req.sourceAmount) {
      console.warn(
        `[meld] resuming ${fundingRequestId} priced at ${status.sourceAmount} ${status.fiat ?? ""}, not the ${req.sourceAmount} just quoted; the rate moved since it was opened`,
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
      // Normalize to decimal strings and drop offers with no serviceProvider.
      const quotes: MeldQuoteEntry[] = raw
        .filter((q) => q.serviceProvider != null && String(q.serviceProvider) !== "")
        .map((q) => ({
          serviceProvider: String(q.serviceProvider),
          sourceAmount: String(q.sourceAmount ?? ""),
          destinationAmount: String(q.destinationAmount ?? ""),
          ...(q.totalFee != null ? { totalFee: String(q.totalFee) } : {}),
          ...(q.networkFee != null ? { networkFee: String(q.networkFee) } : {}),
          // Meld returns customerScore as a string. Coerce it and keep it only when finite.
          ...((): { customerScore?: number } => {
            // A blank score is unscored, not 0.
            const text =
              typeof q.customerScore === "string" ? q.customerScore.trim() : q.customerScore;
            const cs = Number(text);
            return text != null && text !== "" && Number.isFinite(cs) ? { customerScore: cs } : {};
          })(),
        }));
      return { quotes };
    },
    async createSession(req) {
      // Walk the attempt forward past concluded ones only. A caller-supplied key is used verbatim
      // and never walked. `REQUEST_OUTCOME_UNKNOWN`, `REQUEST_IN_FLIGHT` and
      // `REQUEST_ALREADY_SETTLED` are rethrown.
      let lastRefusal: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const externalSessionId = nextKey?.() ?? intentKey(req, attempt);
        try {
          const data = await post(
            "/session",
            {
              idempotencyKey: externalSessionId,
              country: req.country,
              fiat: req.sourceCurrencyCode,
              destinationCurrencyCode: req.destinationCurrencyCode,
              sourceAmount: req.sourceAmount,
              walletAddress: req.walletAddress,
              paymentMethodType: req.paymentMethodType,
              // Required by the adapter, sent unconditionally.
              serviceProvider: req.serviceProvider,
              ...(config.redirectUrl ? { redirectUrl: config.redirectUrl } : {}),
            },
            "Starting the payment",
          );
          const fundingRequestId = String(data.fundingRequestId ?? "");
          if (!fundingRequestId) {
            throw new Error(
              "[meld] the adapter returned no fundingRequestId; status could not be polled",
            );
          }
          const widgetUrl = String(data.serviceProviderWidgetUrl ?? "");
          const meldWidgetUrl = data.widgetUrl != null ? String(data.widgetUrl) : undefined;
          if (!widgetUrl && !meldWidgetUrl) {
            throw new Error(
              `[meld] the adapter returned no pay page for funding request ${fundingRequestId}; there is nothing for the buyer to pay on`,
            );
          }
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
            const resumed = await resume(err.fundingRequestId, externalSessionId, req);
            if (resumed) return resumed;
            // The row exists but has no pay page left: it concluded or its capture page closed.
            throw new AdapterRefusal(
              "This purchase is already open and can no longer be paid here. Contact support with your reference. Do not start another.",
              err.status,
              err.code,
              err.fundingRequestId,
              { cause: err },
            );
          }
          // `REQUEST_SURFACE_EXPIRED`: the pay page lapsed but the row is live. Return a
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
        `This purchase has already been completed ${MAX_ATTEMPTS} times. If you are expecting funds that have not arrived, contact support with your wallet address. Starting another will not help.`,
        lastRefusal instanceof Error ? { cause: lastRefusal } : undefined,
      );
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
