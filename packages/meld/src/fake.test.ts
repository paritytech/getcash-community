// The offline sell script, and the refusals it can now stand in for. This fake is what the layers
// above are built and demoed against; if its sequence or its refusals are wrong, they are built
// wrong. It is built on `createMeldClient` itself (see fake.ts's header), so these tests are
// exercising `client.ts`'s own idempotency walk, resume comparison and refusal mapping — not a
// second copy of that logic.

import { describe, expect, it } from "vitest";
import { createFakeMeldClient } from "./fake";

const SELL_REQ = {
  serviceProvider: "TRANSAK",
  orderRef: "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9",
  country: "US",
  sourceCurrencyCode: "DOT_ASSETHUB",
  sourceAmount: "10",
  destinationCurrencyCode: "USD",
  destinationAmount: "67.90",
  paymentMethodType: "ACH",
};

describe("createFakeMeldClient sell", () => {
  it("quotes crypto in and fiat out", async () => {
    const client = createFakeMeldClient({ usdPerToken: 7, feePct: 3, providers: ["TRANSAK"] });

    const { quotes } = await client.getSellQuote({
      country: "US",
      sourceCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "10",
      destinationCurrencyCode: "USD",
      paymentMethodType: "ACH",
    });

    // 10 tokens at 7 is 70 fiat, less the 3% fee.
    expect(quotes[0]?.sourceAmount).toBe("10");
    expect(quotes[0]?.destinationAmount).toBe("67.90");
    expect(quotes[0]?.totalFee).toBe("2.10");
  });

  it("echoes the crypto leg verbatim rather than rounding it", async () => {
    // Ten decimals is what DOT has. This fake is what the downstream build reads the committed
    // amount from, so rounding here would quietly undo the precision the sell path exists for.
    const client = createFakeMeldClient({ providers: ["TRANSAK"] });

    const { quotes } = await client.getSellQuote({
      country: "US",
      sourceCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "24.4123456789",
      destinationCurrencyCode: "USD",
      paymentMethodType: "ACH",
    });

    expect(quotes[0]?.sourceAmount).toBe("24.4123456789");
  });

  it("discloses the deposit terms only after the scripted KYC polls", async () => {
    const client = createFakeMeldClient({ sellPollsBeforeDepositAddress: 2 });
    const { fundingRequestId } = await client.createSellSession(SELL_REQ);

    const poll = () => client.getStatus(fundingRequestId);
    // Every poll carries the row's own committed terms — live or concluded, this is what makes
    // the resume comparison able to run at all; see the "resume" describe block below.
    const terms = { fiat: "USD", destinationCurrencyCode: "DOT_ASSETHUB", cryptoAmount: "10" };

    expect(await poll()).toMatchObject({ status: "session_opened", ...terms });
    expect(await poll()).toMatchObject({ status: "session_opened", ...terms });
    // Disclosed: the address, for exactly the committed amount, in the asset being sold.
    expect(await poll()).toMatchObject({
      status: "session_opened",
      ...terms,
      deposit: { amount: "10", currency: "DOT_ASSETHUB" },
    });
    const seen = await poll();
    expect(seen.status).toBe("transaction_seen");
    expect(seen.deposit?.address).toBeTruthy();
    // Concluded, so the hosted surface and the deposit terms are both withdrawn: the adapter
    // reports neither once a row is no longer live. The committed terms remain — a settled row
    // is still the same sale.
    expect(await poll()).toMatchObject({ status: "settled", ...terms });
    expect(await poll()).not.toHaveProperty("deposit");
    expect(await poll()).not.toHaveProperty("serviceProviderWidgetUrl");
    // Terminal: it stays settled however long the caller keeps polling.
    expect(await poll()).toMatchObject({ status: "settled" });
  });

  it("leaves a buy's status fixed, so the sell script cannot leak into it", async () => {
    const client = createFakeMeldClient({ status: "session_opened" });
    await client.createSellSession(SELL_REQ);
    const { fundingRequestId } = await client.createSession({
      serviceProvider: "TRANSAK",
      country: "US",
      sourceCurrencyCode: "USD",
      sourceAmount: "20.00",
      destinationCurrencyCode: "DOT_ASSETHUB",
      destinationAmount: "2.8",
      walletAddress: "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    });

    for (let i = 0; i < 4; i += 1) {
      expect(await client.getStatus(fundingRequestId)).toEqual({ status: "session_opened" });
    }
  });
});

describe("createFakeMeldClient sell resume", () => {
  it("resumes a live sale rather than opening a second one, for the same order ref", async () => {
    const client = createFakeMeldClient();
    const first = await client.createSellSession(SELL_REQ);

    // Same intent (same order ref, corridor, method): the real adapter answers
    // IDEMPOTENCY_KEY_REUSED, and the client resumes the row it names rather than minting
    // another. Before this file scripted that reuse, nothing ever exercised this path.
    const second = await client.createSellSession(SELL_REQ);

    expect(second.fundingRequestId).toBe(first.fundingRequestId);
  });

  it("refuses a resumed sale committed to a different amount, driven end to end through the client", async () => {
    // The hazard this whole comparison exists for: back out of a sale still live and start a
    // different-sized one under the same order ref. On a sell there is no address to notice the
    // mismatch by — `cryptoAmount` is the only thing standing between this and being handed the
    // first sale's surface while believing the second amount was agreed to.
    const client = createFakeMeldClient();
    await client.createSellSession(SELL_REQ);

    await expect(client.createSellSession({ ...SELL_REQ, sourceAmount: "50" })).rejects.toThrow(
      /different order/i,
    );
  });

  it("does not resume a sale for a different order ref", async () => {
    const client = createFakeMeldClient();
    const first = await client.createSellSession(SELL_REQ);
    const second = await client.createSellSession({ ...SELL_REQ, orderRef: "a-different-order" });

    expect(second.fundingRequestId).not.toBe(first.fundingRequestId);
  });
});

describe("createFakeMeldClient refusals", () => {
  it("scripts a quote refusal for both directions, through the client's own message mapping", async () => {
    const client = createFakeMeldClient({ quoteRefusal: { tag: "NoQuotesAvailable" } });

    await expect(
      client.getQuote({
        country: "US",
        sourceCurrencyCode: "USD",
        destinationCurrencyCode: "DOT_ASSETHUB",
        sourceAmount: "20.00",
        paymentMethodType: "CREDIT_DEBIT_CARD",
      }),
    ).rejects.toThrow(/not available/i);

    await expect(
      client.getSellQuote({
        country: "US",
        sourceCurrencyCode: "DOT_ASSETHUB",
        sourceAmount: "10",
        destinationCurrencyCode: "USD",
        paymentMethodType: "ACH",
      }),
    ).rejects.toThrow(/not available/i);
  });

  it("scripts BelowMinimum on a sell session create with the bare fallback the server actually sends", async () => {
    // The adapter's `threshold()` never attaches a value to a sell's BelowMinimum/AboveMaximum:
    // Meld's sell limit text has no parseable threshold, and the adapter refuses to guess the
    // denomination rather than name a wrongly-denominated figure. A seller under the minimum
    // sees the bare fallback, never a named threshold — scripting a value here would give false
    // confidence about what a seller actually sees.
    const client = createFakeMeldClient({ sessionRefusal: { tag: "BelowMinimum" } });

    await expect(client.createSellSession(SELL_REQ)).rejects.toThrow(/below the minimum/i);
    await expect(client.createSellSession(SELL_REQ)).rejects.not.toThrow(/\d USD/);
  });

  it("scripts BelowMinimum on a buy session create, naming the threshold", async () => {
    // Unlike a sell, the buy side's threshold is one unambiguous fiat denomination, and the
    // adapter does attach it.
    const client = createFakeMeldClient({
      sessionRefusal: { tag: "BelowMinimum", value: { amount: "10.00", currency: "USD" } },
    });

    await expect(
      client.createSession({
        serviceProvider: "TRANSAK",
        country: "US",
        sourceCurrencyCode: "USD",
        sourceAmount: "1.00",
        destinationCurrencyCode: "DOT_ASSETHUB",
        destinationAmount: "0.14",
        walletAddress: "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9",
        paymentMethodType: "CREDIT_DEBIT_CARD",
      }),
    ).rejects.toThrow(/10\.00 USD/);
  });

  it("scripts an Other-tagged region/method refusal on a sell session create", async () => {
    const client = createFakeMeldClient({
      sessionRefusal: {
        tag: "Other",
        value: { code: "PAYMENT_METHOD_UNSUPPORTED", message: "Not supported here." },
      },
    });

    await expect(client.createSellSession(SELL_REQ)).rejects.toThrow(/PAYMENT_METHOD_UNSUPPORTED/);
  });

  it("scripts a 409 conclusion code other than key-reuse on session create", async () => {
    // REQUEST_CONCLUDED is walked past MAX_ATTEMPTS times before the client gives up; scripting
    // it as a standing refusal (rather than only on reuse) is what lets a test drive that walk
    // through the fake instead of only through a raw fetch stub.
    const client = createFakeMeldClient({
      sessionRefusal: {
        tag: "Other",
        status: 409,
        value: { code: "REQUEST_CONCLUDED", message: "concluded" },
      },
    });

    await expect(client.createSellSession(SELL_REQ)).rejects.toThrow();
  });

  it("scripts cancel refusing not-cancellable", async () => {
    const client = createFakeMeldClient({ cancelRefusal: "not-cancellable" });
    expect(await client.cancel("mock-sell-funding-1")).toEqual({ outcome: "not-cancellable" });
  });

  it("scripts cancel refusing not-found", async () => {
    const client = createFakeMeldClient({ cancelRefusal: "not-found" });
    expect(await client.cancel("nope")).toEqual({ outcome: "not-found" });
  });

  it("cancels normally when nothing is scripted", async () => {
    const client = createFakeMeldClient();
    const { fundingRequestId } = await client.createSellSession(SELL_REQ);
    expect(await client.cancel(fundingRequestId)).toMatchObject({ outcome: "cancelled" });
  });
});

describe("createFakeMeldClient sell cancel", () => {
  it("withholds the hosted surface and the deposit from every later poll once cancelled", async () => {
    // The real server's `cancelled_at` turns `live` false independently of status, so a later
    // GET withholds the widget URLs and the deposit and reports `cancelledAt` — the cancel call
    // succeeding must not leave a later poll still handing back a live-looking row.
    const client = createFakeMeldClient({ sellPollsBeforeDepositAddress: 0 });
    const { fundingRequestId } = await client.createSellSession(SELL_REQ);
    // Past the address poll count, so a row that failed to notice the cancel would disclose it.
    const disclosed = await client.getStatus(fundingRequestId);
    expect(disclosed.deposit).toBeTruthy();

    await client.cancel(fundingRequestId);

    const after = await client.getStatus(fundingRequestId);
    expect(after.status).toBe("cancelled");
    expect(after).not.toHaveProperty("deposit");
    expect(after).not.toHaveProperty("serviceProviderWidgetUrl");
    expect(after).not.toHaveProperty("widgetUrl");
    // Terminal: stays this way however long the caller keeps polling.
    expect(await client.getStatus(fundingRequestId)).toMatchObject({ status: "cancelled" });
  });

  it("refuses reopening a cancelled sale's key with REQUEST_CANCELLED, which the client walks past safely", async () => {
    // End to end through the real client: a cancelled key is dead, not live, so the adapter
    // refuses reuse with REQUEST_CANCELLED rather than IDEMPOTENCY_KEY_REUSED, and on a sell
    // that is safe to walk past — nothing was ever sent, so the client opens a fresh session
    // under the next attempt rather than refusing.
    const client = createFakeMeldClient();
    const first = await client.createSellSession(SELL_REQ);
    await client.cancel(first.fundingRequestId);

    const second = await client.createSellSession(SELL_REQ);

    expect(second.fundingRequestId).not.toBe(first.fundingRequestId);
    // The new row is live: a real session to continue, not another dead one.
    const status = await client.getStatus(second.fundingRequestId);
    expect(status.status).not.toBe("cancelled");
  });
});
