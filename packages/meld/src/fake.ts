// A scriptable Meld adapter, offline: canned quotes at a demo rate, a session with a stand-in
// hosted URL, and a scriptable status/refusal set. This is what the whole off-ramp is built,
// tested and demoed against, so it does not implement `MeldClientLike` by hand — it implements a
// fake `fetch` and hands it to `createMeldClient`. That is not a style choice: `createMeldClient`
// owns the idempotency-key walk, the resume comparison and the refusal-to-message mapping
// (`messageForTag`), and a hand-rolled mock object runs none of that code. Scripting only the wire
// responses means every path a real adapter can put this client through — including the ones nothing
// has hit yet — is reachable from a test, and the two can never drift apart the way a second,
// mock-shaped implementation of the same logic eventually would.

import { createMeldClient, type MeldClientLike, type MeldSellClientLike } from "./client";

/** A scripted adapter refusal, in the same vocabulary `messageForTag` reads off a real one: a
 *  tag, its value, and the HTTP status the adapter answered with (400 for a quote/session term
 *  the request itself violates, 409 for a conclusion code about an existing row). The default
 *  below is 400 for every tag a caller does not give its own `status`, which is not exactly what
 *  the adapter sends for all of them (`NoQuotesAvailable` is 422, say) — harmless here, since
 *  `client.ts` branches on the tag rather than the status for everything but the 409 codes, but a
 *  caller asserting on the response status itself should pass one explicitly. */
export interface FakeRefusal {
  readonly tag: string;
  readonly status?: number;
  readonly value?: {
    amount?: string;
    currency?: string;
    code?: string;
    message?: string;
  };
}

export interface FakeMeldOptions {
  /** Demo fiat price per whole native token. Default 7 (≈ USD/DOT ballpark). */
  usdPerToken?: number;
  /** Provider fee, percent of the pre-fee fiat. Default 3. */
  feePct?: number;
  /**
   * Provider names, cheapest first; each later one is priced slightly higher. Default TRANSAK,
   * KOYWE.
   */
  providers?: string[];
  /** Status every buy poll returns, in the adapter's vocabulary. Default 'session_opened'. Also
   *  the status for a sell funding id this instance never opened. */
  status?: string;
  /**
   * Sell only: how many status polls answer before the deposit address appears. Stands in for the
   * seller working through KYC on the hosted page, which is the only reason the address is late.
   * Default 2; 0 makes it present from the first poll.
   */
  sellPollsBeforeDepositAddress?: number;
  /** Sell only: the address the provider "issues" for the seller to send to. */
  sellDepositAddress?: string;
  /** Refuses every quote (buy or sell) with this tag. Exercises the same `messageForTag` mapping
   *  a real `NoQuotesAvailable` / `BelowMinimum` / `AboveMaximum` / region-or-method `Other` would. */
  quoteRefusal?: FakeRefusal;
  /**
   * Refuses every session create (buy or sell) with this tag, checked before the idempotency-key
   * bookkeeping below. Scripts the quote-shaped refusals on `/session` and the 409 conclusion
   * codes that are not about the state of an existing row under this key: `REQUEST_SURFACE_EXPIRED`,
   * `REQUEST_CONCLUDED`, `REQUEST_IN_FLIGHT`, `REQUEST_OUTCOME_UNKNOWN`, `REQUEST_ALREADY_SETTLED`.
   * `IDEMPOTENCY_KEY_REUSED` and, on a sell, `REQUEST_CANCELLED` need no entry here: both are
   * scripted by the ordinary sequence that produces them for real — opening a sale and opening it
   * again for the first, cancelling it and then opening it again for the second — which is what
   * lets a test drive the resume path and the cancelled-key path rather than merely assert either
   * is theoretically reachable.
   */
  sessionRefusal?: FakeRefusal;
  /** Refuses every cancel with `REQUEST_NOT_CANCELLABLE` (409) or `not-found` (404). */
  cancelRefusal?: "not-cancellable" | "not-found";
}

/** The flat partner fee real card quotes carry, in fiat units. */
const PARTNER_FEE = 0.5;

/** A well-formed Asset Hub address, so what the sell script hands back looks like the real
 *  thing. Nothing here checks it: SS58 validation belongs at the send site, before a transfer is
 *  signed, not at this boundary. */
const DEPOSIT_ADDRESS = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";

/** A sell row this fake has opened, keyed by the funding-request id it minted. Everything a
 *  persisted sell row on the real server carries: its committed terms (present for the row's
 *  whole life — the real server enforces `cryptoAmount` with a database constraint, and the resume
 *  comparison in `client.ts` has nothing to compare against if this fake ever left it out) and how
 *  many status polls it has answered. */
interface FakeSellRow {
  polls: number;
  sessionId: string;
  fiat: string;
  crypto: string;
  cryptoAmount: string;
  /** Set once `cancel()` succeeds against this row. The real server's `cancelled_at` turns its
   *  `live` predicate false independently of `status`, which is what withholds the hosted surface
   *  and the deposit from every later poll — see `sellFundingBody`. */
  cancelledAt?: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refusalResponse(r: FakeRefusal, fallbackStatus: number): Response {
  return jsonResponse(r.status ?? fallbackStatus, { error: { tag: r.tag, value: r.value } });
}

/**
 * Builds a fake adapter's `fetch`: the same three routes `createMeldClient` speaks
 * (`POST /quote`, `POST /session`, `GET /funding/:id`, `POST /funding/:id/cancel`), answered from
 * scripted options rather than a live Meld account.
 */
function fakeAdapterFetch(opts: FakeMeldOptions): typeof fetch {
  const rate = opts.usdPerToken ?? 7;
  const feePct = opts.feePct ?? 3;
  const providers = opts.providers ?? ["TRANSAK", "KOYWE"];
  const status = opts.status ?? "session_opened";
  const pollsBeforeAddress = opts.sellPollsBeforeDepositAddress ?? 2;
  const depositAddress = opts.sellDepositAddress ?? DEPOSIT_ADDRESS;
  let sessionSeq = 0;

  /** Sell sessions opened here, by the idempotency key that opened them, so a repeated key (a
   *  reload, or a second sale minting attempt-1 of the same order ref) is refused exactly as the
   *  adapter refuses it — naming the row already open — rather than silently minting a second
   *  one. Scoped to sell: the buy path is the one already in production against the real adapter
   *  and is left exactly as this fake has always run it. */
  const sellByKey = new Map<string, string>();
  const sellRows = new Map<string, FakeSellRow>();

  function widgetUrls(sessionId: string) {
    return {
      serviceProviderWidgetUrl: `https://global-stg.transak.com/?sessionId=${sessionId}`,
      widgetUrl: `https://sb.meldcrypto.com/?sessionId=${sessionId}`,
    };
  }

  function quotesFor(body: Record<string, unknown>) {
    const sell = body.direction === "sell";
    if (sell) {
      // Reverse: crypto in -> fiat out. The seller sends `cryptoAmount` of the token; the fee
      // comes off the fiat before it is paid out.
      const tokens = Number(body.cryptoAmount) || 0;
      const gross = tokens * rate;
      return providers.map((serviceProvider, i) => {
        const fee = (gross * feePct) / 100;
        const out = Math.max(gross - fee, 0) * (1 - i * 0.02); // later providers a touch worse
        return {
          serviceProvider,
          // Echoed exactly as asked for. Rounding it here would round away the precision the
          // whole crypto-amount path exists to protect, in the one place downstream code reads
          // the committed figure from.
          sourceAmount: String(body.cryptoAmount ?? ""),
          destinationAmount: out.toFixed(2),
          totalFee: fee.toFixed(2),
          transactionFee: Math.max(fee - PARTNER_FEE, 0).toFixed(2),
          partnerFee: PARTNER_FEE.toFixed(2),
          customerScore: 100 - i,
        };
      });
    }
    // Forward: fiat in -> crypto out.
    const fiat = Number(body.sourceAmount) || 0;
    const fee = (fiat * feePct) / 100;
    const netFiat = Math.max(fiat - fee, 0);
    return providers.map((serviceProvider, i) => {
      const out = (netFiat / rate) * (1 - i * 0.02); // later providers a touch worse
      return {
        serviceProvider,
        sourceAmount: fiat.toFixed(2),
        destinationAmount: out.toFixed(8),
        totalFee: fee.toFixed(2),
        transactionFee: Math.max(fee - PARTNER_FEE, 0).toFixed(2),
        partnerFee: PARTNER_FEE.toFixed(2),
        customerScore: 100 - i,
      };
    });
  }

  /** The sell script, one step per poll: the seller does KYC (no terms yet), the provider issues
   *  the deposit terms, the seller sends and the transfer is seen, then it settles. The row's own
   *  committed terms (fiat, crypto, cryptoAmount) are reported on every poll, live or concluded —
   *  what makes the resume comparison in `client.ts` able to run at all. The hosted surface is
   *  reported only while live: the adapter withholds it once the row concludes, which is what
   *  makes a resumed-but-concluded row fail closed instead of handing back a dead page.
   *
   *  A cancelled row short-circuits all of that, permanently: `live` is false the moment
   *  `cancelledAt` is set, regardless of how many KYC polls it had answered, so neither the
   *  surface nor the deposit terms come back on a later poll — the row does not merely stop
   *  advancing, it stops disclosing. */
  function sellFundingBody(row: FakeSellRow) {
    if (row.cancelledAt !== undefined) {
      return {
        status: "cancelled",
        fiat: row.fiat,
        destinationCurrencyCode: row.crypto,
        cryptoAmount: row.cryptoAmount,
        cancelledAt: row.cancelledAt,
      };
    }
    const poll = row.polls;
    row.polls += 1;
    const settled = poll >= pollsBeforeAddress + 2;
    const sellStatus = settled
      ? "settled"
      : poll === pollsBeforeAddress + 1
        ? "transaction_seen"
        : "session_opened";
    const disclosed = poll >= pollsBeforeAddress && !settled;
    return {
      status: sellStatus,
      fiat: row.fiat,
      destinationCurrencyCode: row.crypto,
      cryptoAmount: row.cryptoAmount,
      ...(settled ? {} : widgetUrls(row.sessionId)),
      ...(disclosed
        ? {
            deposit: {
              address: depositAddress,
              amount: row.cryptoAmount,
              currency: row.crypto,
              observedAt: Date.now(),
            },
          }
        : {}),
    };
  }

  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === "POST" && url.pathname === "/quote") {
      if (opts.quoteRefusal) return refusalResponse(opts.quoteRefusal, 400);
      return jsonResponse(200, { quotes: quotesFor(body) });
    }

    if (method === "POST" && url.pathname === "/session") {
      if (opts.sessionRefusal) return refusalResponse(opts.sessionRefusal, 409);
      const sell = body.direction === "sell";
      if (!sell) {
        // Unchanged from before this file was rewritten: every buy create mints a fresh session.
        sessionSeq += 1;
        const sessionId = `mock-meld-${sessionSeq}`;
        const fundingRequestId = `mock-funding-${sessionSeq}`;
        return jsonResponse(201, { fundingRequestId, sessionId, ...widgetUrls(sessionId) });
      }
      const key = String(body.idempotencyKey ?? "");
      const existing = sellByKey.get(key);
      if (existing !== undefined) {
        const existingRow = sellRows.get(existing);
        // A cancelled row is dead, not live: the adapter refuses the key with
        // `REQUEST_CANCELLED`, not `IDEMPOTENCY_KEY_REUSED` — there is nothing left under this
        // key for `resume()` to attach to.
        if (existingRow?.cancelledAt !== undefined) {
          return jsonResponse(409, {
            error: {
              tag: "Other",
              value: {
                code: "REQUEST_CANCELLED",
                message: "this sale was cancelled",
              },
            },
          });
        }
        return jsonResponse(409, {
          error: {
            tag: "Other",
            value: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "a sale is already open under this key",
              fundingRequestId: existing,
            },
          },
        });
      }
      sessionSeq += 1;
      const sessionId = `mock-meld-sell-${sessionSeq}`;
      const fundingRequestId = `mock-sell-funding-${sessionSeq}`;
      sellByKey.set(key, fundingRequestId);
      sellRows.set(fundingRequestId, {
        polls: 0,
        sessionId,
        fiat: String(body.fiat ?? ""),
        crypto: String(body.destinationCurrencyCode ?? ""),
        cryptoAmount: String(body.cryptoAmount ?? ""),
      });
      return jsonResponse(201, { fundingRequestId, sessionId, ...widgetUrls(sessionId) });
    }

    const funding = url.pathname.match(/^\/funding\/([^/]+)(\/cancel)?$/);
    if (funding) {
      const id = decodeURIComponent(funding[1] ?? "");
      const isCancel = funding[2] !== undefined;

      if (isCancel && method === "POST") {
        if (opts.cancelRefusal === "not-found") {
          return jsonResponse(404, { error: { tag: "Other", value: { code: "NOT_FOUND" } } });
        }
        if (opts.cancelRefusal === "not-cancellable") {
          return jsonResponse(409, {
            error: {
              tag: "Other",
              value: {
                code: "REQUEST_NOT_CANCELLABLE",
                message: "A payment is already on its way.",
              },
            },
          });
        }
        const cancelledAt = Date.now();
        const row = sellRows.get(id);
        if (row) row.cancelledAt = cancelledAt;
        return jsonResponse(200, { funding: { cancelledAt } });
      }

      if (!isCancel && method === "GET") {
        const row = sellRows.get(id);
        if (row) return jsonResponse(200, { funding: sellFundingBody(row) });
        // A buy id, or a sell id this instance never opened: the fixed status, nothing else —
        // buy status has never varied with polls, and there is no row to say more about either.
        return jsonResponse(200, { funding: { status } });
      }
    }

    throw new Error(`[fake meld] unexpected request: ${method} ${url.pathname}`);
  };
}

/** Builds a fake Meld client over `createMeldClient` itself: an offline `fetch` standing in for
 *  the adapter, so this client runs the exact idempotency walk, resume comparison and refusal
 *  mapping a real one does. See this file's header. */
export function createFakeMeldClient(
  opts: FakeMeldOptions = {},
): MeldClientLike & MeldSellClientLike {
  return createMeldClient({
    baseUrl: "https://fake.meld.local",
    fetchImpl: fakeAdapterFetch(opts),
  });
}
