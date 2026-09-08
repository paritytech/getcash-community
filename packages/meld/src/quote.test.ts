import { describe, expect, it } from "vitest";
import type { ReverseQuoteInput } from "@getsome/core";
import type { MeldClientLike, MeldQuoteEntry, MeldQuoteRequest } from "./client";
import { computeMeldQuote, pickBestQuote, type MeldQuoteContext, type MeldQuoteRaw } from "./quote";

const CTX: MeldQuoteContext = {
  country: "US",
  fiat: "USD",
  token: "DOT_ASSETHUB",
  method: "CREDIT_DEBIT_CARD",
};

/** A forward fake: fiat in, crypto out at `rate` (crypto per fiat). Records each request in
 *  `reqs`. */
function rateClient(rate: number, reqs?: MeldQuoteRequest[]): MeldClientLike {
  return {
    getQuote: async (req) => {
      reqs?.push(req);
      const fiat = Number(req.sourceAmount);
      const out = fiat * rate;
      return {
        quotes: [
          {
            serviceProvider: "TRANSAK",
            sourceAmount: fiat.toFixed(2),
            destinationAmount: out.toFixed(8),
          },
        ],
      };
    },
    createSession: async () => ({
      fundingRequestId: "funding-1",
      sessionId: "sess",
      externalSessionId: "ext",
      widgetUrl: "https://pay",
    }),
    getStatus: async () => ({ status: "PENDING" }),
  };
}

/** A fake returning fixed quotes. */
function fixedClient(quotes: MeldQuoteEntry[]): MeldClientLike {
  return {
    getQuote: async () => ({ quotes }),
    createSession: async () => ({
      fundingRequestId: "funding-1",
      sessionId: "sess",
      externalSessionId: "ext",
      widgetUrl: "https://pay",
    }),
    getStatus: async () => ({ status: "PENDING" }),
  };
}

/** 20 DOT in plancks (10 dec). */
const twentyDot = (): ReverseQuoteInput => ({
  sourceId: "dot-assethub",
  target: { amount: 200_000_000_000n, decimals: 10 },
});

const line = (
  serviceProvider: string,
  sourceAmount: string,
  destinationAmount: string,
  customerScore?: number,
): MeldQuoteEntry => ({
  serviceProvider,
  sourceAmount,
  destinationAmount,
  ...(customerScore !== undefined ? { customerScore } : {}),
});

describe("computeMeldQuote (forward inversion)", () => {
  it("sends a source-denominated request with the route currencies", async () => {
    const reqs: MeldQuoteRequest[] = [];
    // rate 1: the $20 probe delivers the 20-DOT target in one call.
    await computeMeldQuote(rateClient(1, reqs), CTX, twentyDot());
    expect(reqs[0]).toEqual({
      country: "US",
      sourceCurrencyCode: "USD",
      destinationCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "20.00",
      paymentMethodType: "CREDIT_DEBIT_CARD",
    });
  });

  it("returns a core Quote describing the native target, with the chosen provider on raw", async () => {
    const quote = await computeMeldQuote(rateClient(1), CTX, twentyDot());
    expect(quote.sourceId).toBe("dot-assethub");
    expect(quote.source).toEqual({
      amount: 200_000_000_000n,
      formatted: "20",
      assetSymbol: "DOT",
      decimals: 10,
    });
    const raw = quote.raw as MeldQuoteRaw;
    expect(raw.provider.serviceProvider).toBe("TRANSAK");
    expect(raw.destinationAmount).toBe("20");
    expect(raw.context).toEqual(CTX);
  });

  it("solves the fiat when the first probe under-delivers (rate < 1)", async () => {
    // rate 0.5: a $20 probe yields 10 DOT (short of 20); the solver bumps the fiat until ≥ 20 DOT.
    const reqs: MeldQuoteRequest[] = [];
    const quote = await computeMeldQuote(rateClient(0.5, reqs), CTX, twentyDot());
    const raw = quote.raw as MeldQuoteRaw;
    expect(Number(raw.provider.destinationAmount)).toBeGreaterThanOrEqual(20);
    expect(Number(raw.provider.sourceAmount)).toBeGreaterThan(20); // more than the naive $20
    expect(reqs.length).toBeGreaterThan(1); // it iterated
  });

  it("solves down when the first probe over-delivers (rate > 1)", async () => {
    // rate 1.2: a $20 probe yields 24 DOT; the solver corrects down to the cheapest fiat that
    // still clears 20.
    const reqs: MeldQuoteRequest[] = [];
    const quote = await computeMeldQuote(rateClient(1.2, reqs), CTX, twentyDot());
    const raw = quote.raw as MeldQuoteRaw;
    expect(Number(raw.provider.destinationAmount)).toBeGreaterThanOrEqual(20); // still clears target
    expect(Number(raw.provider.sourceAmount)).toBeLessThan(20); // cheaper than the naive $20
    expect(reqs.length).toBeGreaterThan(1); // it iterated
  });

  it("widens a sub-native (6-dec CASH) target to 10-dec native on the source amount", async () => {
    const quote = await computeMeldQuote(rateClient(1), CTX, {
      sourceId: "dot-assethub",
      target: { amount: 20_000_001n, decimals: 6 }, // 20.000001
    });
    expect(quote.source.formatted).toBe("20.000001");
    expect(quote.source.amount).toBe(200_000_010_000n);
  });

  it("throws when Meld offers no provider for the route", async () => {
    await expect(computeMeldQuote(fixedClient([]), CTX, twentyDot())).rejects.toThrow(
      /No Meld provider/,
    );
  });

  it("refuses an unusable line instead of quoting it", async () => {
    // A provider line with no price (a missing `destinationAmount` normalizes to "0").
    const dead = fixedClient([line("TRANSAK", "20.00", "0")]);
    await expect(computeMeldQuote(dead, CTX, twentyDot())).rejects.toThrow(/unusable quote/);
  });

  it("refuses a solve that never reaches the target rather than under-delivering", async () => {
    // Every probe comes back short, however much fiat is offered.
    const capped: MeldClientLike = {
      getQuote: async (req) => ({
        quotes: [line("TRANSAK", Number(req.sourceAmount).toFixed(2), "19.00")],
      }),
      createSession: async () => {
        throw new Error("not used");
      },
      getStatus: async () => ({ status: "created" }),
    };
    await expect(computeMeldQuote(capped, CTX, twentyDot())).rejects.toThrow(/could not price/);
  });
});

describe("pickBestQuote", () => {
  it("picks the line delivering the most crypto for the fiat", () => {
    const worse = line("A", "20.00", "19.00");
    const better = line("B", "20.00", "20.50");
    expect(pickBestQuote([worse, better])?.serviceProvider).toBe("B");
  });

  it("breaks a tie on the higher customerScore", () => {
    const a = line("A", "20.00", "20.00", 10);
    const b = line("B", "20.00", "20.00", 90);
    expect(pickBestQuote([a, b])?.serviceProvider).toBe("B");
  });

  it("returns null for an empty pool", () => {
    expect(pickBestQuote([])).toBeNull();
  });
});
