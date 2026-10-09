import { describe, expect, it } from "vitest";
import { TOKENS, type ReverseQuoteInput } from "@getsome/core";
import type { MeldQuoteEntry, MeldQuoteRequest } from "../client";
import type { MeldQuoter, MeldQuoteRaw } from "../quote";
import type { MeldHeadlessClient } from "./client";
import { createMeldHeadlessRail, type MeldHeadlessRailOptions } from "./rail";
import type { BankInstructions, HeadlessOrder, HeadlessOrderRequest } from "./types";

const BURNER = "5EphemeralBurnerAddressxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TERMS_AT = "2026-10-08T10:00:00.000Z";

const LINE: MeldQuoteEntry = {
  serviceProvider: "BANXA",
  sourceAmount: "141.89",
  destinationAmount: "20.63",
  destinationNetworkCode: "POLKADOT_ASSETHUB",
};

const BANK: BankInstructions = {
  rail: "SEPA",
  amount: "141.89",
  currency: "EUR",
  iban: "DE89370400440532013000",
  reference: "REF-1",
};

function quoter(quotes: MeldQuoteEntry[] = [LINE], sent: MeldQuoteRequest[] = []): MeldQuoter {
  return {
    getQuote: async (req) => {
      sent.push(req);
      return { quotes };
    },
  };
}

function orderClient(
  order: HeadlessOrder = { fundingRequestId: "funding-1", kind: "card", order: { id: "o-1" } },
  over: Partial<Pick<MeldHeadlessClient, "getFunding">> = {},
) {
  const sent: HeadlessOrderRequest[] = [];
  const client: MeldHeadlessRailOptions["client"] = {
    createOrder: async (req) => {
      sent.push(req);
      return order;
    },
    getFunding: async () => ({ status: "session_opened", integrationMode: "headless" }),
    ...over,
  };
  return { client, sent };
}

function railWith(over: Partial<MeldHeadlessRailOptions> = {}) {
  return createMeldHeadlessRail({
    client: orderClient().client,
    quoteClient: quoter(),
    country: "DE",
    fiat: "EUR",
    termsAcceptedAt: () => TERMS_AT,
    ...over,
  });
}

const twentyDot = (): ReverseQuoteInput => ({
  sourceId: "dot-assethub",
  target: { amount: 200_000_000_000n, decimals: 10 },
});

describe("createMeldHeadlessRail", () => {
  it("advertises the same source as the widget rail", () => {
    const rail = railWith({ method: "BANK_TRANSFER" });
    expect(rail.sources()).toEqual([
      {
        sourceId: "meld-bank",
        chain: "AssetHub",
        asset: "DOT",
        displayName: "Bank transfer · Meld",
        decimals: 10,
      },
    ]);
  });

  it("asks for headless quotes and keeps the line's chain on the quote", async () => {
    const sent: MeldQuoteRequest[] = [];
    const rail = railWith({ quoteClient: quoter([LINE], sent) });
    const quote = await rail.getQuote(twentyDot());
    const raw = quote.raw as MeldQuoteRaw;

    expect(sent[0]).toMatchObject({
      integrationMode: "headless",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    });
    expect(raw.context.integrationMode).toBe("headless");
    expect(raw.provider.destinationNetworkCode).toBe("POLKADOT_ASSETHUB");
  });

  it("passes over a line without a chain, and refuses when none has one", async () => {
    const chainless: MeldQuoteEntry = {
      serviceProvider: "TRANSAK",
      sourceAmount: "141.89",
      destinationAmount: "25",
    };
    const quote = await railWith({ quoteClient: quoter([chainless, LINE]) }).getQuote(twentyDot());
    expect((quote.raw as MeldQuoteRaw).provider.serviceProvider).toBe("BANXA");

    await expect(
      railWith({ quoteClient: quoter([chainless]) }).getQuote(twentyDot()),
    ).rejects.toThrow(/No Meld provider/);
  });

  it("orders for the burner with the quoted line, its chain and the terms time", async () => {
    const { client, sent } = orderClient();
    const rail = railWith({ client, token: TOKENS.USDT });
    const quote = await rail.getQuote(twentyDot());
    await rail.requestDepositAddress({ quote, destAddress: BURNER, refundAddress: "" });

    expect(sent).toEqual([
      {
        idempotencyKey: `getcash-order-${BURNER}-EUR-USDT_ASSETHUB-CREDIT_DEBIT_CARD-DE`,
        country: "DE",
        fiat: "EUR",
        destinationCurrencyCode: "USDT_ASSETHUB",
        sourceAmount: "141.89",
        walletAddress: BURNER,
        paymentMethodType: "CREDIT_DEBIT_CARD",
        serviceProvider: "BANXA",
        destinationNetworkCode: "POLKADOT_ASSETHUB",
        termsAcceptedAt: TERMS_AT,
      },
    ]);
  });

  it("reads the terms time when the order is placed, not when the rail is built", async () => {
    let at = "2026-10-08T09:00:00.000Z";
    const { client, sent } = orderClient();
    const rail = railWith({ client, termsAcceptedAt: () => at });
    const quote = await rail.getQuote(twentyDot());
    at = TERMS_AT;
    await rail.requestDepositAddress({ quote, destAddress: BURNER, refundAddress: "" });
    expect(sent[0]?.termsAcceptedAt).toBe(TERMS_AT);
  });

  it("maps a card order to a channel on the burner, with the order kept and no pay URL", async () => {
    const rail = railWith();
    expect(rail.payment("funding-1")).toBeUndefined();

    const quote = await rail.getQuote(twentyDot());
    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: BURNER,
      refundAddress: "",
    });

    expect(channel.depositChannelId).toBe("funding-1");
    expect(channel.deposit).toMatchObject({
      address: BURNER,
      amount: quote.source.amount,
      formatted: quote.source.formatted,
      assetSymbol: "DOT",
    });
    expect(channel.deposit).not.toHaveProperty("payUrl");
    expect(channel.deposit.expiresAt - Date.now()).toBeGreaterThan(2 * 60 * 60 * 1000);
    expect(rail.payment("funding-1")).toEqual({ kind: "card", order: { id: "o-1" } });
    expect(rail.payUrl("funding-1")).toBeUndefined();
  });

  it("keeps a bank order's instructions and takes their expiry", async () => {
    const expiresAt = Date.now() + 9 * 60 * 60 * 1000;
    const { client } = orderClient({
      fundingRequestId: "funding-2",
      kind: "bank",
      instructions: { ...BANK, expiresAt },
    });
    const rail = railWith({ client, method: "BANK_TRANSFER", paymentMethodType: "SEPA" });
    const quote = await rail.getQuote(twentyDot());
    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: BURNER,
      refundAddress: "",
    });

    expect(channel.deposit.expiresAt).toBe(expiresAt);
    expect(rail.payment("funding-2")).toEqual({
      kind: "bank",
      instructions: { ...BANK, expiresAt },
    });
    expect(rail.payUrl("funding-2")).toBeUndefined();
  });

  it("refuses a quote that is not a headless Meld quote", async () => {
    const { client, sent } = orderClient();
    const rail = railWith({ client });
    const quote = await rail.getQuote(twentyDot());
    const raw = quote.raw as MeldQuoteRaw;
    const widget = {
      ...quote,
      raw: { ...raw, context: { ...raw.context, integrationMode: undefined } },
    };
    const chainless = {
      ...quote,
      raw: { ...raw, provider: { ...raw.provider, destinationNetworkCode: undefined } },
    };

    for (const bad of [{ ...quote, raw: {} }, widget, chainless]) {
      await expect(
        rail.requestDepositAddress({ quote: bad, destAddress: BURNER, refundAddress: "" }),
      ).rejects.toThrow(/Meld order needs/);
    }
    expect(sent).toEqual([]);
  });

  it("maps the funding status as the widget rail does", async () => {
    const asked: string[] = [];
    const { client } = orderClient(undefined, {
      getFunding: async (id) => {
        asked.push(id);
        return { status: "failed", providerStatus: "DECLINED", integrationMode: "headless" };
      },
    });
    const status = await railWith({ client }).getStatus("funding-1");

    expect(asked).toEqual(["funding-1"]);
    expect(status).toMatchObject({
      status: "failed",
      depositFailure: { reason: { code: "declined" }, kind: "deposit-rejected" },
    });
    const settled = orderClient(undefined, {
      getFunding: async () => ({ status: "settled", integrationMode: "headless" }),
    });
    expect((await railWith({ client: settled.client }).getStatus("f")).status).toBe("complete");
  });

  it("reports available liquidity (route availability is enforced at quote time)", async () => {
    expect((await railWith().probeLiquidity("dot-assethub")).status).toBe("available");
  });
});
