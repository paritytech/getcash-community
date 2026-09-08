// Pricing the source leg: the three answers the pay card renders, none of which throws.

import { describe, expect, it } from "vitest";
import { BelowMinimumSwapAmountError, type QuoteBackend } from "@getsome/chainflip";
import { priceSourceLeg } from "../lib/source-price";

/** 100 DOT of budget, the shape computeQuote's reference step expects. */
const DOT_TARGET = 1_000_000_000_000n;

function backend(quotes: (amount: bigint) => unknown[]): QuoteBackend {
  return {
    async getQuoteV2(args) {
      const out = quotes(BigInt(args.amount));
      return { quotes: out };
    },
  };
}

describe("priceSourceLeg", () => {
  it("returns Chainflip's amount and its own duration estimate", async () => {
    const result = await priceSourceLeg({
      sourceId: "btc",
      targetNativeBase: DOT_TARGET,
      backend: backend((amount) => [
        {
          type: "REGULAR",
          // A linear rate: 1 sat buys 4e6 plancks, which covers the target.
          egressAmount: (amount * 4_000_000n).toString(),
          ingressAmount: amount.toString(),
          estimatedDurationSeconds: 1009.5,
        },
      ]),
    });
    expect(result.kind).toBe("price");
    if (result.kind !== "price") return;
    expect(result.price.formatted).toMatch(/^\d/);
    expect(result.price.etaSeconds).toBe(1009.5);
  });

  it("reports the floor in the asset's units and how far the ask fell short", async () => {
    const result = await priceSourceLeg({
      sourceId: "btc",
      targetNativeBase: 1n, // a purchase far under any real floor
      backend: {
        async getQuoteV2(args) {
          // The reference call succeeds; the precise call is below the floor.
          if (BigInt(args.amount) > 10_000n) {
            return { quotes: [{ type: "REGULAR", egressAmount: "1000000000000" }] };
          }
          throw new BelowMinimumSwapAmountError(40_000n);
        },
      },
    });
    expect(result.kind).toBe("minimum");
    if (result.kind !== "minimum") return;
    expect(result.minimum.assetSymbol).toBe("BTC");
    expect(result.minimum.minimumFormatted).toMatch(/^0\.0004/);
    expect(result.minimum.minimumBaseUnits).toBe(40_000n);
    expect(result.minimum.neededBaseUnits).toBeGreaterThan(0n);
    expect(result.minimum.minimumBaseUnits).toBeGreaterThan(result.minimum.neededBaseUnits);
  });

  it("never throws when Chainflip is unreachable", async () => {
    const result = await priceSourceLeg({
      sourceId: "btc",
      targetNativeBase: DOT_TARGET,
      backend: {
        async getQuoteV2() {
          throw new Error("Chainflip quote request failed (HTTP 502): bad gateway");
        },
      },
    });
    expect(result).toEqual({
      kind: "unavailable",
      reason: expect.stringContaining("502") as unknown as string,
    });
  });

  it("says so when the asset is not in the Chainflip catalog", async () => {
    const result = await priceSourceLeg({
      // Served by the manual rail, never by Chainflip.
      sourceId: "dot-assethub",
      targetNativeBase: DOT_TARGET,
      backend: backend(() => []),
    });
    expect(result.kind).toBe("unavailable");
  });
});

describe("priceSourceLeg deadline", () => {
  it("gives up rather than holding a pay card open forever", async () => {
    const started = Date.now();
    const result = await priceSourceLeg({
      sourceId: "btc",
      targetNativeBase: DOT_TARGET,
      timeoutMs: 50,
      backend: { getQuoteV2: () => new Promise(() => {}) }, // never answers
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.reason).toMatch(/longer than/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
