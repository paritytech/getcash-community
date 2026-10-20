import { describe, expect, it } from "vitest";
import { TOKENS, type ReverseQuoteInput } from "@getsome/core";
import {
  createMeldClient,
  type MeldClientLike,
  type MeldQuoteEntry,
  type MeldQuoteRequest,
} from "./client";
import {
  computeMeldQuote,
  MeldAmountOutOfRangeError,
  pickBestQuote,
  type MeldQuoteContext,
  type MeldQuoteRaw,
} from "./quote";

const CTX: MeldQuoteContext = {
  country: "US",
  fiat: "USD",
  token: TOKENS.PAS,
  method: "CREDIT_DEBIT_CARD",
};

/** A forward fake: fiat in, crypto out at `rate` (crypto per fiat). Records each request in
 *  `reqs`. */
function rateClient(rate: number, reqs?: MeldQuoteRequest[]): MeldClientLike {
  return {
    getAssets: async () => [],
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
    cancel: async () => ({ outcome: "cancelled" as const }),
  };
}

/** A fake returning fixed quotes. */
function fixedClient(quotes: MeldQuoteEntry[]): MeldClientLike {
  return {
    getAssets: async () => [],
    getQuote: async () => ({ quotes }),
    createSession: async () => ({
      fundingRequestId: "funding-1",
      sessionId: "sess",
      externalSessionId: "ext",
      widgetUrl: "https://pay",
    }),
    getStatus: async () => ({ status: "PENDING" }),
    cancel: async () => ({ outcome: "cancelled" as const }),
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
      destinationCurrencyCode: "DOT",
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
      getAssets: async () => [],
      getQuote: async (req) => ({
        quotes: [line("TRANSAK", Number(req.sourceAmount).toFixed(2), "19.00")],
      }),
      createSession: async () => {
        throw new Error("not used");
      },
      getStatus: async () => ({ status: "created" }),
      cancel: async () => ({ outcome: "cancelled" as const }),
    };
    await expect(computeMeldQuote(capped, CTX, twentyDot())).rejects.toThrow(/could not price/);
  });
});

/**
 * The real client over a fake adapter that prices like INR against DOT: `rate` DOT per rupee,
 * refusing outside [min, max] with the adapter's BelowMinimum/AboveMaximum and the bound, less a
 * fixed `fee` in fiat. Records each asked amount in `asked`.
 */
function limitedClient(
  rate: number,
  min: number,
  max: number,
  asked: number[],
  fee = 0,
): MeldClientLike {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return createMeldClient({
    baseUrl: "https://adapter.test",
    fetchImpl: async (_url, init) => {
      const fiat = Number(
        (JSON.parse(String(init?.body)) as { sourceAmount: string }).sourceAmount,
      );
      asked.push(fiat);
      if (fiat < min) {
        return json(400, {
          error: { tag: "BelowMinimum", value: { amount: min.toFixed(2), currency: "INR" } },
        });
      }
      if (fiat > max) {
        return json(400, {
          error: { tag: "AboveMaximum", value: { amount: max.toFixed(2), currency: "INR" } },
        });
      }
      return json(200, {
        quotes: [
          {
            serviceProvider: "BANXA",
            sourceAmount: fiat.toFixed(2),
            destinationAmount: (Math.max(fiat - fee, 0) * rate).toFixed(8),
          },
        ],
      });
    },
  });
}

describe("computeMeldQuote (limits)", () => {
  const INR: MeldQuoteContext = { ...CTX, country: "IN", fiat: "INR" };
  // About 560 rupees a DOT; card limits 3,000 to 50,000.
  const RATE = 1 / 560;
  const dot = (whole: number): ReverseQuoteInput => ({
    sourceId: "dot-assethub",
    target: { amount: BigInt(Math.round(whole * 1e10)), decimals: 10 },
  });

  it("probes at the method's minimum, not the target's number read as fiat", async () => {
    const asked: number[] = [];
    const ctx = { ...INR, limits: { min: "3000.00", max: "50000.00" } };
    const quote = await computeMeldQuote(limitedClient(RATE, 3000, 50000, asked), ctx, dot(8.9));
    expect(asked[0]).toBe(3000);
    const raw = quote.raw as MeldQuoteRaw;
    expect(Number(raw.provider.destinationAmount)).toBeGreaterThanOrEqual(8.9);
    // 8.9 DOT at 560 a DOT is about 4,984 rupees; the buffer keeps it within a percent.
    expect(Number(raw.provider.sourceAmount)).toBeGreaterThanOrEqual(4984);
    expect(Number(raw.provider.sourceAmount)).toBeLessThanOrEqual(4984 * 1.011);
  });

  it("learns the minimum from a refusal when the caller had no limits", async () => {
    const asked: number[] = [];
    const quote = await computeMeldQuote(limitedClient(RATE, 3000, 50000, asked), INR, dot(8.9));
    // The 8.90 guess is refused on the minimum, and the probe moves there.
    expect(asked.slice(0, 2)).toEqual([8.9, 3000]);
    expect(Number((quote.raw as MeldQuoteRaw).provider.destinationAmount)).toBeGreaterThanOrEqual(
      8.9,
    );
  });

  it("refuses a target that costs less than the minimum, naming the bound and the cost", async () => {
    const asked: number[] = [];
    const ctx = { ...INR, limits: { min: "3000.00", max: "50000.00" } };
    const err = await computeMeldQuote(limitedClient(RATE, 3000, 50000, asked), ctx, dot(2)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MeldAmountOutOfRangeError);
    expect(err).toMatchObject({
      bound: "min",
      limit: "3000.00",
      estimatedFiat: "1120.00",
      fiat: "INR",
    });
    // Only the rate probe went out: the out-of-range amount is never quoted.
    expect(asked).toEqual([3000]);
  });

  it("refuses a target that costs more than the maximum without quoting it", async () => {
    const asked: number[] = [];
    const ctx = { ...INR, limits: { min: "3000.00", max: "50000.00" } };
    const err = await computeMeldQuote(
      limitedClient(RATE, 3000, 50000, asked),
      ctx,
      dot(100),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ bound: "max", limit: "50000.00", estimatedFiat: "56000.00" });
    // The projection only moves the probe to the maximum; the line there settles it.
    expect(asked).toEqual([3000, 50000]);
  });

  it("quotes a target a fixed fee makes look past the maximum from the minimum's line", async () => {
    const asked: number[] = [];
    // A 5 fee at a probe of 20 delivers 15, so a straight line puts 1,000 at 1,333: past the
    // 1,200 maximum. It really costs about 1,005.
    const ctx = { ...INR, limits: { min: "20.00", max: "1200.00" } };
    const quote = await computeMeldQuote(limitedClient(1, 20, 1200, asked, 5), ctx, dot(1000));
    const raw = quote.raw as MeldQuoteRaw;
    expect(asked.slice(0, 2)).toEqual([20, 1200]);
    expect(Number(raw.provider.destinationAmount)).toBeGreaterThanOrEqual(1000);
    expect(Number(raw.provider.sourceAmount)).toBeLessThanOrEqual(1005 * 1.011);
  });

  it("names a bound the corridor did not, when a correction is refused on it", async () => {
    const asked: number[] = [];
    // The caller knew the minimum only; the maximum comes back on the refused correction.
    const ctx = { ...INR, limits: { min: "3000.00" } };
    const err = await computeMeldQuote(
      limitedClient(RATE, 3000, 50000, asked),
      ctx,
      dot(100),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ bound: "max", limit: "50000.00", estimatedFiat: "56000.00" });
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
