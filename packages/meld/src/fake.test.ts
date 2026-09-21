// The offline sell script. The adapter's sell routes do not exist yet, so this fake is what the
// layers above are built and demoed against; if its sequence is wrong they are built wrong.

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

    expect(await poll()).toEqual({ status: "session_opened" });
    expect(await poll()).toEqual({ status: "session_opened" });
    // Disclosed: the address, for exactly the committed amount, in the asset being sold.
    expect(await poll()).toMatchObject({
      status: "session_opened",
      deposit: { amount: "10", currency: "DOT_ASSETHUB" },
    });
    const seen = await poll();
    expect(seen.status).toBe("transaction_seen");
    expect(seen.deposit?.address).toBeTruthy();
    // Concluded, so the terms are withdrawn: the adapter discloses them only while live.
    expect(await poll()).toEqual({ status: "settled" });
    // Terminal: it stays settled however long the caller keeps polling.
    expect(await poll()).toEqual({ status: "settled" });
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
