// The sale's side of the Meld boundary: what the client sends the adapter for a sell, what it reads
// back, the offline script, and the sale as the withdrawal's rail leg sees it.

import { afterEach, describe, expect, it } from "vitest";
import { installMeldAssets, MeldAssetsUnavailable } from "@getsome/core";
import { TEST_MELD_ASSETS } from "../../../tests/setup-meld-assets";
import { createMeldClient } from "./client";
import { createFakeMeldClient } from "./fake";
import type { MeldClientLike, MeldQuoteEntry, MeldStatusResult } from "./client";
import {
  directSellCodes,
  formatSellAmount,
  isDirectSellCode,
  isDirectUsdt,
  SALE_GONE_AFTER,
  SALE_GONE_FOR_MS,
  directSellToken,
  saleChannelOf,
  saleRail,
  saleStatusView,
  sameSoldAsset,
  sellAmountOf,
  sellQuoteUsable,
  SELL_TOKEN,
  USDT_SELL_TOKEN,
  type SaleReadMemory,
} from "./sell";
import { parseBaseUnits } from "./units";

/** A fetch stub answering a scripted sequence, one response per call, the last repeating. */
function stubSequence(responses: readonly { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const body = (call: { init: RequestInit | undefined }) =>
  JSON.parse(String(call.init?.body)) as Record<string, unknown>;

const SELL_REQ = {
  serviceProvider: "TRANSAK",
  orderRef: "5KeyAddress",
  country: "DE",
  sourceCurrencyCode: "DOT",
  sourceAmount: "23.4521",
  destinationCurrencyCode: "EUR",
  paymentMethodType: "SEPA",
};

const created = {
  status: 201,
  body: {
    fundingRequestId: "funding-sell-1",
    sessionId: "s1",
    serviceProviderWidgetUrl: "https://kyc.test",
  },
};

describe("createMeldClient sell quotes", () => {
  it("asks the quote route for a sale, the crypto leg named as the adapter names it", async () => {
    const { impl, calls } = stubSequence([
      {
        status: 200,
        body: {
          quotes: [
            {
              serviceProvider: "TRANSAK",
              sourceAmount: 23.4521,
              destinationAmount: 90.12,
              totalFee: 3.1,
            },
          ],
        },
      },
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test/", fetchImpl: impl });
    const { quotes } = await client.getSellQuote({
      country: "DE",
      sourceCurrencyCode: "DOT",
      sourceAmount: "23.4521",
      destinationCurrencyCode: "EUR",
      paymentMethodType: "SEPA",
    });
    expect(calls[0]!.url).toBe("https://adapter.test/quote");
    expect(body(calls[0]!)).toEqual({
      direction: "sell",
      country: "DE",
      fiat: "EUR",
      destinationCurrencyCode: "DOT",
      // Never `sourceAmount`, which the adapter validates as fiat.
      cryptoAmount: "23.4521",
      paymentMethodType: "SEPA",
    });
    expect(quotes).toEqual([
      {
        serviceProvider: "TRANSAK",
        sourceAmount: "23.4521",
        destinationAmount: "90.12",
        totalFee: "3.1",
      },
    ]);
  });
});

describe("createMeldClient sell sessions", () => {
  it("opens a sale for the committed crypto, naming no wallet", async () => {
    const { impl, calls } = stubSequence([created]);
    const client = createMeldClient({
      baseUrl: "https://adapter.test",
      redirectUrl: "https://adapter.test/meld/return",
      fetchImpl: impl,
    });
    const session = await client.createSellSession(SELL_REQ);
    expect(calls[0]!.url).toBe("https://adapter.test/session");
    const sent = body(calls[0]!);
    expect(sent).toMatchObject({
      direction: "sell",
      country: "DE",
      fiat: "EUR",
      destinationCurrencyCode: "DOT",
      cryptoAmount: "23.4521",
      paymentMethodType: "SEPA",
      serviceProvider: "TRANSAK",
      redirectUrl: "https://adapter.test/meld/return",
    });
    // Optional on a sale at Meld, and refused by the adapter.
    expect(sent).not.toHaveProperty("walletAddress");
    // The order reference is key material, not a term the adapter is told.
    expect(sent).not.toHaveProperty("orderRef");
    expect(String(sent.idempotencyKey)).toContain("sell");
    expect(String(sent.idempotencyKey)).toContain(SELL_REQ.orderRef);
    expect(session).toMatchObject({
      fundingRequestId: "funding-sell-1",
      widgetUrl: "https://kyc.test",
    });
  });

  it("keeps a buy and a sale of one pair on different keys", async () => {
    const { impl, calls } = stubSequence([created]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await client.createSellSession(SELL_REQ);
    await client.createSession({
      serviceProvider: "TRANSAK",
      country: "DE",
      sourceCurrencyCode: "EUR",
      sourceAmount: "90.00",
      destinationCurrencyCode: "DOT",
      destinationAmount: "23",
      walletAddress: SELL_REQ.orderRef,
      paymentMethodType: "SEPA",
    });
    expect(body(calls[0]!).idempotencyKey).not.toBe(body(calls[1]!).idempotencyKey);
  });

  it("refuses to resume into a sale opened for another amount", async () => {
    const { impl } = stubSequence([
      {
        status: 409,
        body: {
          error: {
            tag: "Other",
            value: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "reused",
              fundingRequestId: "funding-live",
            },
          },
        },
      },
      {
        status: 200,
        body: {
          funding: {
            status: "session_opened",
            serviceProviderWidgetUrl: "https://kyc.test/resume",
            fiat: "EUR",
            destinationCurrencyCode: "DOT",
            cryptoAmount: "50",
          },
        },
      },
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    await expect(client.createSellSession(SELL_REQ)).rejects.toThrow(/different order/);
  });

  it("resumes the same sale under the same key", async () => {
    const { impl } = stubSequence([
      {
        status: 409,
        body: {
          error: {
            tag: "Other",
            value: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "reused",
              fundingRequestId: "funding-live",
            },
          },
        },
      },
      {
        status: 200,
        body: {
          funding: {
            status: "session_opened",
            serviceProviderWidgetUrl: "https://kyc.test/resume",
            fiat: "EUR",
            destinationCurrencyCode: "DOT",
            cryptoAmount: "23.4521",
          },
        },
      },
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    const session = await client.createSellSession(SELL_REQ);
    expect(session).toMatchObject({
      fundingRequestId: "funding-live",
      widgetUrl: "https://kyc.test/resume",
    });
  });
});

describe("createMeldClient sell status", () => {
  const funding = (deposit: Record<string, unknown> | undefined) => ({
    status: 200,
    body: {
      funding: {
        status: "transaction_seen",
        direction: "sell",
        cryptoAmount: "23.4521",
        ...(deposit === undefined ? {} : { deposit }),
      },
    },
  });

  it("reads the deposit terms the adapter discloses", async () => {
    const { impl } = stubSequence([
      funding({
        address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
        amount: "23.4521",
        currency: "DOT",
        observedAt: 1_800,
      }),
    ]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    expect(await client.getStatus("funding-sell-1")).toEqual({
      status: "transaction_seen",
      cryptoAmount: "23.4521",
      deposit: {
        address: "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM",
        amount: "23.4521",
        currency: "DOT",
        observedAt: 1_800,
      },
    });
  });

  it("takes half a disclosure as none", async () => {
    for (const deposit of [
      { address: "", amount: "23.4521", currency: "DOT", observedAt: 1 },
      { address: "14Kt", amount: "", currency: "DOT", observedAt: 1 },
      { address: "14Kt", amount: "1", currency: "", observedAt: 1 },
      { address: "14Kt", amount: "1", currency: "DOT" },
    ]) {
      const { impl } = stubSequence([funding(deposit)]);
      const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
      expect(await client.getStatus("funding-sell-1")).not.toHaveProperty("deposit");
    }
  });

  it("reads when the provider named another address, which the adapter then stops disclosing", async () => {
    const conflicted = (depositConflictAt: unknown) => ({
      status: 200,
      body: { funding: { status: "transaction_seen", direction: "sell", depositConflictAt } },
    });
    const { impl } = stubSequence([conflicted(1_900), conflicted("1900")]);
    const client = createMeldClient({ baseUrl: "https://adapter.test", fetchImpl: impl });
    expect(await client.getStatus("funding-sell-1")).toEqual({
      status: "transaction_seen",
      depositConflictAt: 1_900,
    });
    expect(await client.getStatus("funding-sell-1")).not.toHaveProperty("depositConflictAt");
  });
});

describe("the offline sale", () => {
  it("answers KYC polls first, then discloses the deposit for the committed amount", async () => {
    const client = createFakeMeldClient({ sellPollsBeforeDeposit: 2 });
    const session = await client.createSellSession(SELL_REQ);
    expect((await client.getStatus(session.fundingRequestId)).deposit).toBeUndefined();
    expect((await client.getStatus(session.fundingRequestId)).deposit).toBeUndefined();
    const disclosed = await client.getStatus(session.fundingRequestId);
    expect(disclosed.deposit).toMatchObject({ amount: "23.4521", currency: "DOT" });
    // Once the address is out the sale cannot be withdrawn.
    expect(await client.cancel(session.fundingRequestId)).toEqual({ outcome: "not-cancellable" });
  });

  it("tags its sale ids when asked, and ends a sale it never opened", async () => {
    const client = createFakeMeldClient({ saleIdTag: "load2" });
    expect((await client.createSellSession(SELL_REQ)).fundingRequestId).toBe("mock-sell-load2-1");
    // Opened by an earlier load of the page, whose memory is gone.
    expect(await client.getStatus("mock-sell-load1-1")).toEqual({ status: "expired" });
    // A buy it does not know still reads as the fixed status.
    expect(await client.getStatus("funding-1")).toEqual({ status: "session_opened" });
  });

  it("stops disclosing anything for a sale cancelled during KYC", async () => {
    const client = createFakeMeldClient({ sellPollsBeforeDeposit: 1 });
    const session = await client.createSellSession(SELL_REQ);
    expect(await client.cancel(session.fundingRequestId)).toEqual({ outcome: "cancelled" });
    for (let i = 0; i < 3; i += 1) {
      expect((await client.getStatus(session.fundingRequestId)).deposit).toBeUndefined();
    }
  });

  it("quotes a sale crypto in, fiat out, the fees off the payout", async () => {
    const client = createFakeMeldClient({ usdPerToken: 4, feePct: 2 });
    const { quotes } = await client.getSellQuote({
      country: "DE",
      sourceCurrencyCode: "DOT",
      sourceAmount: "10",
      destinationCurrencyCode: "EUR",
      paymentMethodType: "SEPA",
    });
    // 40 gross, 0.8 + 0.5 in fees.
    expect(quotes[0]).toMatchObject({
      sourceAmount: "10",
      destinationAmount: "38.70",
      totalFee: "1.30",
    });
  });
});

describe("the sale as the rail leg reads it", () => {
  const disclosed = {
    status: "transaction_seen",
    deposit: { address: "14Kt", amount: "23.4521", currency: "DOT", observedAt: 1 },
  };

  it("is a channel to an address for an exact figure, paid out off chain", () => {
    expect(saleChannelOf(disclosed, SELL_TOKEN)).toEqual({
      depositAddress: "14Kt",
      payout: "off-chain",
      expired: false,
      expectedAmount: 234_521_000_000n,
    });
  });

  it("takes a deposit only under the code the adapter's table gives the sold asset", () => {
    expect(sameSoldAsset("DOT", "DOT")).toBe(true);
    expect(sameSoldAsset("USDC_SOLANA", "DOT")).toBe(false);
    expect(sameSoldAsset("USDT_DOT", "DOT")).toBe(false);
    expect(sameSoldAsset("USDT_SOLANA", "USDT_DOT")).toBe(false);
    // The codes Meld retired name nothing any more, so a deposit under one is not this sale's.
    const retired = { ...disclosed, deposit: { ...disclosed.deposit, currency: "DOT_ASSETHUB" } };
    expect(saleChannelOf(retired, SELL_TOKEN)).toBeNull();
    expect(sameSoldAsset("DOT_STATEMINT", "DOT")).toBe(false);
  });

  it("takes a deposit in any of the tokens it is offered, read in that token's decimals", () => {
    const usdc = { symbol: "USDC", decimals: 6, meldCurrencyCode: "USDC_SOLANA" };
    const usdt = { symbol: "USDT", decimals: 6, meldCurrencyCode: "USDT_SOLANA" };
    const lane: MeldStatusResult = {
      status: "transaction_seen",
      deposit: { address: "9WzD", amount: "24.5", currency: "USDC_SOLANA", observedAt: 1 },
    };
    expect(saleChannelOf(lane, [usdt, usdc])?.expectedAmount).toBe(24_500_000n);
    expect(saleChannelOf(lane, [usdt])).toBeNull();
  });

  it("is closed once the adapter concludes it", () => {
    expect(saleChannelOf({ ...disclosed, status: "expired" }, SELL_TOKEN)?.expired).toBe(true);
  });

  it("is no channel without a disclosure, for another asset, or for an unreadable amount", () => {
    expect(saleChannelOf({ status: "session_opened" }, SELL_TOKEN)).toBeNull();
    expect(
      saleChannelOf(
        { ...disclosed, deposit: { ...disclosed.deposit, currency: "USDT_DOT" } },
        SELL_TOKEN,
      ),
    ).toBeNull();
    expect(
      saleChannelOf(
        { ...disclosed, deposit: { ...disclosed.deposit, amount: "1.00000000001" } },
        SELL_TOKEN,
      ),
    ).toBeNull();
  });

  it("ends the follow when the provider changed the deposit after the key paid", () => {
    const changed = saleStatusView({ status: "transaction_seen", depositConflictAt: 1_900 });
    expect(changed.status).toBe("failed");
    expect(changed.depositFailure?.reason).toMatchObject({
      code: "changed",
      message: expect.stringMatching(/changed the sale after your payment/),
    });
    // A payout already settled stands.
    expect(saleStatusView({ status: "settled", depositConflictAt: 1_900 }).status).toBe("complete");
  });

  it("follows the payout to its end in the seller's words", () => {
    expect(saleStatusView({ status: "settled" }).status).toBe("complete");
    expect(saleStatusView({ status: "transaction_seen" }).status).toBe("receiving");
    const refunded = saleStatusView({ status: "failed", providerStatus: "REFUNDED" });
    expect(refunded.status).toBe("failed");
    expect(refunded.depositFailure?.reason).toMatchObject({ code: "refunded" });
    expect(saleStatusView({ status: "expired" }).depositFailure?.reason?.message).toMatch(/closed/);
  });
});

describe("sale amounts", () => {
  it("cuts a figure to the sale's decimals, never up", () => {
    expect(sellAmountOf(234_521_987_654n, SELL_TOKEN)).toBe(234_521_000_000n);
    expect(formatSellAmount(234_521_000_000n, SELL_TOKEN)).toBe("23.4521");
  });

  it("parses a decimal exactly, refusing more precision than the token has", () => {
    expect(parseBaseUnits(SELL_TOKEN, "23.4521")).toBe(234_521_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "7")).toBe(70_000_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "0.00000000001")).toBeNull();
    expect(parseBaseUnits(SELL_TOKEN, "-1")).toBeNull();
    expect(parseBaseUnits(SELL_TOKEN, "1e3")).toBeNull();
  });

  it("reads trailing zeros as no value, as a provider may pad its amount", () => {
    expect(parseBaseUnits(SELL_TOKEN, "23.452100000000000000")).toBe(234_521_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "7.0")).toBe(70_000_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "7.")).toBe(70_000_000_000n);
    expect(parseBaseUnits(SELL_TOKEN, "0.00000000010")).toBe(1n);
    // A digit past the token's own is still refused, however it is padded.
    expect(parseBaseUnits(SELL_TOKEN, "0.000000000010")).toBeNull();
    expect(parseBaseUnits(SELL_TOKEN, "0.00000000001")).toBeNull();
  });
});

describe("the sale's reads for the worker", () => {
  const live: MeldStatusResult = {
    status: "transaction_seen",
    deposit: {
      address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      amount: "23.4521",
      currency: "DOT",
      observedAt: 1,
    },
  };
  const notFound = Object.assign(new Error("not found"), { status: 404 });

  /** A client whose `getStatus` answers from `script`, one entry per call, an Error thrown. */
  function scripted(script: readonly (MeldStatusResult | Error)[]): MeldClientLike {
    let call = 0;
    return {
      getStatus: async () => {
        const next = script[Math.min(call, script.length - 1)]!;
        call += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as MeldClientLike;
  }

  it("reads the channel and the status through the adapter", async () => {
    const rail = saleRail(scripted([live, { status: "settled" }]), {}, Date.now, SELL_TOKEN);
    expect(await rail.channel("funding-1")).toMatchObject({ expectedAmount: 234_521_000_000n });
    expect(await rail.status("funding-1")).toMatchObject({ status: "complete" });
  });

  it("reads the deposit of a sale of USDT in USDT's units", async () => {
    const usdt = {
      status: "transaction_seen",
      deposit: { address: "14Kt", amount: "25", currency: "USDT_DOT", observedAt: 1 },
    };
    const rail = saleRail(scripted([usdt]), {}, Date.now, USDT_SELL_TOKEN);
    expect(await rail.channel("funding-1")).toMatchObject({ expectedAmount: 25_000_000n });
    // A deposit for DOT is not this sale's.
    expect(await saleRail(scripted([live]), {}, Date.now, USDT_SELL_TOKEN).channel("f")).toBeNull();
  });

  it("takes a sale the adapter keeps answering 404 for as gone, and only then", async () => {
    const memory: SaleReadMemory = {};
    let clock = 1_000_000;
    const rail = saleRail(scripted([notFound]), memory, () => clock, SELL_TOKEN);
    for (let read = 1; read < SALE_GONE_AFTER; read += 1) {
      await expect(rail.channel("funding-1")).rejects.toBe(notFound);
      expect(memory.saleNotFound).toBe(read);
      clock += 60_000;
    }
    // Enough answers, but not for long enough: an adapter restarting is not a lost sale.
    clock = 1_000_000 + SALE_GONE_FOR_MS - 1;
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    clock = 1_000_000 + SALE_GONE_FOR_MS;
    // No channel to pay: the leg fails it as a mismatch and the key goes home.
    expect(await rail.channel("funding-1")).toBeNull();
    expect(memory.saleNotFoundSince).toBe(1_000_000);
    // Once paid, a payout nobody can confirm.
    expect(await rail.status("funding-1")).toMatchObject({
      status: "failed",
      depositFailure: { reason: { code: "unobserved" } },
    });
  });

  it("starts the count again after an answer, and throws any other failure as it is", async () => {
    const memory: SaleReadMemory = {};
    const boom = Object.assign(new Error("bad gateway"), { status: 502 });
    const rail = saleRail(
      scripted([notFound, notFound, live, notFound, boom]),
      memory,
      Date.now,
      SELL_TOKEN,
    );
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    expect(await rail.channel("funding-1")).not.toBeNull();
    expect(memory.saleNotFound).toBeUndefined();
    expect(memory.saleNotFoundSince).toBeUndefined();
    await expect(rail.channel("funding-1")).rejects.toBe(notFound);
    expect(memory.saleNotFound).toBe(1);
    await expect(rail.channel("funding-1")).rejects.toBe(boom);
    expect(memory.saleNotFound).toBe(1);
  });
});

describe("which quote lines can carry a sale", () => {
  const line = (serviceProvider: string, destinationAmount = "90.12"): MeldQuoteEntry => ({
    serviceProvider,
    sourceAmount: "23.4521",
    destinationAmount,
  });

  it("keeps the providers that send the seller back, and drops the standard-flow ones", () => {
    for (const name of ["TRANSAK", "BANXA", "ALCHEMYPAY", "REVOLUT", "UNLIMIT"]) {
      expect(sellQuoteUsable(line(name))).toBe(true);
    }
    for (const name of ["COINBASEPAY", "COINBASE_PAY", "Koywe", "PAYBIS", "ROBINHOOD"]) {
      expect(sellQuoteUsable(line(name))).toBe(false);
    }
  });

  it("drops a payout that is not a positive number", () => {
    for (const payout of ["", "0", "-1", "abc"]) {
      expect(sellQuoteUsable(line("TRANSAK", payout))).toBe(false);
    }
  });
});

describe("what a direct sale sells", () => {
  afterEach(() => {
    installMeldAssets(TEST_MELD_ASSETS);
  });

  it("is USDT or DOT, under the codes the adapter's table names them by", () => {
    expect(directSellCodes()).toEqual(["USDT_DOT", "DOT"]);
    expect(directSellToken("USDT_DOT")).toBe(USDT_SELL_TOKEN);
    expect(directSellToken("DOT")).toBe(SELL_TOKEN);
    expect(isDirectSellCode("USDT_DOT")).toBe(true);
    expect(isDirectSellCode("DOT")).toBe(true);
    expect(isDirectSellCode(undefined)).toBe(false);
    expect(isDirectUsdt("USDT_DOT")).toBe(true);
    expect(isDirectUsdt("DOT")).toBe(false);
    expect(isDirectUsdt(undefined)).toBe(false);
    expect(USDT_SELL_TOKEN).toMatchObject({
      symbol: "USDT",
      decimals: 6,
      meldCurrencyCode: "USDT_DOT",
    });
    expect(formatSellAmount(25_000_000n, USDT_SELL_TOKEN)).toBe("25");
  });

  it("follows the adapter when Meld renames a code, with no release", () => {
    installMeldAssets([
      { asset: "dot@assethub", code: "DOT_V3" },
      { asset: "usdt@assethub", code: "USDT_V3" },
    ]);
    expect(SELL_TOKEN.meldCurrencyCode).toBe("DOT_V3");
    expect(USDT_SELL_TOKEN.meldCurrencyCode).toBe("USDT_V3");
    expect(directSellCodes()).toEqual(["USDT_V3", "DOT_V3"]);
    expect(isDirectSellCode("DOT")).toBe(false);
  });

  it("names no code before the adapter's table is read", () => {
    installMeldAssets([]);
    expect(() => SELL_TOKEN.meldCurrencyCode).toThrow(MeldAssetsUnavailable);
    expect(isDirectSellCode("DOT")).toBe(false);
  });

  it("is nothing else, a lane's code and a retired code included", () => {
    expect(() => directSellToken("USDC_DOT")).toThrow("cannot sell USDC_DOT");
    expect(() => directSellToken("USDC_ARBITRUM")).toThrow("cannot sell USDC_ARBITRUM");
    expect(() => directSellToken("DOT_STATEMINT")).toThrow("cannot sell DOT_STATEMINT");
  });
});

describe("a sale of another asset", () => {
  const USDT_SOLANA = { symbol: "USDT", decimals: 6, meldCurrencyCode: "USDT_SOLANA" };

  it("commits, formats and reads its deposit in that asset's units", () => {
    expect(sellAmountOf(98_852_550n, USDT_SOLANA)).toBe(98_852_500n);
    expect(formatSellAmount(98_850_000n, USDT_SOLANA)).toBe("98.85");
    const deposit = {
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      amount: "98.85",
      observedAt: 1,
    };
    expect(
      saleChannelOf(
        { status: "transaction_seen", deposit: { ...deposit, currency: "USDT_SOLANA" } },
        USDT_SOLANA,
      ),
    ).toMatchObject({ depositAddress: deposit.address, expectedAmount: 98_850_000n });
    expect(
      saleChannelOf(
        { status: "transaction_seen", deposit: { ...deposit, currency: "DOT" } },
        USDT_SOLANA,
      ),
    ).toBeNull();
  });
});
