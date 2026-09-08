import { describe, expect, it } from "vitest";
import {
  computeQuote,
  ON_CHAIN_OVERHEAD_PLANCKS,
  pickRegularQuote,
  SourceMinimumNotMetError,
  type QuoteBackend,
} from "./quote";
import { SOURCE_CONFIG_BY_ID, formatSourceAmount } from "./sources";
import { BelowMinimumSwapAmountError, type GetQuoteV2Args } from "./sdk";

const btc = SOURCE_CONFIG_BY_ID.get("btc")!;

/** Fake backend with a fixed linear rate: egress plancks = amount * rate. */
function rateBackend(rate: bigint) {
  const calls: GetQuoteV2Args[] = [];
  const backend: QuoteBackend = {
    async getQuoteV2(args) {
      calls.push(args);
      const egress = (BigInt(args.amount) * rate).toString();
      return {
        quotes: [{ type: "REGULAR", egressAmount: egress, ingressAmount: args.amount }],
      };
    },
  };
  return { backend, calls };
}

// 250000 sats reference * 4_000_000 = 1e12 plancks (100 DOT) reference output.
const RATE = 4_000_000n;
const TARGET = 500_000_000_000n; // 50 DOT
const TOTAL_NEEDED = TARGET + ON_CHAIN_OVERHEAD_PLANCKS; // 505e9

// srcNeededExact = 505e9 * 250000 / 1e12 = 126250; x1.05 -> 132562 (floor of 132562.5)
const EXPECTED_FIRST_PRECISE = 132_562n;

describe("computeQuote (reverse-quote)", () => {
  it("reports Chainflip's floor instead of quietly buying more than was asked for", async () => {
    const amounts: string[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        amounts.push(args.amount);
        if (amounts.length === 1) {
          return { quotes: [{ type: "REGULAR", egressAmount: "1000000000000" }] };
        }
        if (BigInt(args.amount) < 40_000n) {
          throw new BelowMinimumSwapAmountError(40_000n);
        }
        return {
          quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: "1000000000000" }],
        };
      },
    };

    // Asking for 1 planck of DOT needs ~1000 sats; Chainflip's floor is 40000.
    const failure = await computeQuote(backend, btc, 1n, 0n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SourceMinimumNotMetError);
    const err = failure as SourceMinimumNotMetError;
    expect(err.minimumBaseUnits).toBe(40_000n);
    expect(err.neededBaseUnits).toBe(1_000n);
    expect(err.assetSymbol).toBe(btc.shortName);
    expect(err.message).toMatch(/smallest BTC swap/);
    // The floor was never sent as an amount.
    expect(amounts).toEqual([btc.referenceAmountBaseUnits, "1000"]);
  });

  // The app has to turn this error into a CASH sentence using minimum/needed.
  it.todo("surfaces the source minimum to the buyer in CASH terms");

  it("still quotes normally when the amount clears the floor", async () => {
    const amounts: string[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        amounts.push(args.amount);
        if (BigInt(args.amount) < 500n) throw new BelowMinimumSwapAmountError(500n);
        return {
          quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: "1000000000000" }],
        };
      },
    };

    const quote = await computeQuote(backend, btc, 1n, 0n);
    expect(quote.source.amount).toBe(1_000n);
  });

  it("accepts on the first precise quote when egress covers target + overhead", async () => {
    const { backend, calls } = rateBackend(RATE);
    const quote = await computeQuote(backend, btc, TARGET);

    expect(calls).toHaveLength(2);
    // reference quote at the catalog's reference amount
    expect(calls[0]).toMatchObject({
      srcChain: "Bitcoin",
      srcAsset: "BTC",
      destChain: "Assethub",
      destAsset: "DOT",
      amount: btc.referenceAmountBaseUnits,
    });
    expect(quote.sourceId).toBe("btc");
    expect(quote.source.amount).toBe(EXPECTED_FIRST_PRECISE);
    expect(quote.source.assetSymbol).toBe("BTC");
    expect(quote.source.decimals).toBe(8);
    // the accepted egress covers the target + overhead
    expect(EXPECTED_FIRST_PRECISE * RATE).toBeGreaterThanOrEqual(TOTAL_NEEDED);
  });

  it("applies the x1.05 slippage buffer to the rate-derived source amount", async () => {
    const { backend, calls } = rateBackend(RATE);
    await computeQuote(backend, btc, TARGET);
    const srcNeededExact = (TOTAL_NEEDED * 250_000n) / 1_000_000_000_000n;
    expect(calls[1]?.amount).toBe(((srcNeededExact * 105n) / 100n).toString());
  });

  it("bump loop re-quotes x1.01 and accepts on a later attempt", async () => {
    const calls: GetQuoteV2Args[] = [];
    let preciseCount = 0;
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        if (calls.length === 1) {
          // reference quote
          return { quotes: [{ type: "REGULAR", egressAmount: (250_000n * RATE).toString() }] };
        }
        preciseCount++;
        const egress = preciseCount < 3 ? (TOTAL_NEEDED - 1n).toString() : TOTAL_NEEDED.toString();
        return { quotes: [{ type: "REGULAR", egressAmount: egress, ingressAmount: args.amount }] };
      },
    };

    const quote = await computeQuote(backend, btc, TARGET);
    expect(calls).toHaveLength(4); // 1 ref + 3 precise
    const a1 = EXPECTED_FIRST_PRECISE;
    const a2 = (a1 * 101n) / 100n;
    const a3 = (a2 * 101n) / 100n;
    expect(calls[1]?.amount).toBe(a1.toString());
    expect(calls[2]?.amount).toBe(a2.toString());
    expect(calls[3]?.amount).toBe(a3.toString());
    expect(quote.source.amount).toBe(a3);
  });

  it("throws a clear error after 5 non-converging precise attempts", async () => {
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        if (calls.length === 1) {
          return { quotes: [{ type: "REGULAR", egressAmount: (250_000n * RATE).toString() }] };
        }
        return { quotes: [{ type: "REGULAR", egressAmount: "1" }] }; // always short
      },
    };
    await expect(computeQuote(backend, btc, TARGET)).rejects.toThrow(
      /BTC amount that covers the target \+ fees after 5 attempts/,
    );
    expect(calls).toHaveLength(6); // 1 ref + 5 precise
  });

  it("throws when the reference quote returns zero output", async () => {
    const backend: QuoteBackend = {
      async getQuoteV2() {
        return { quotes: [{ type: "REGULAR", egressAmount: "0" }] };
      },
    };
    await expect(computeQuote(backend, btc, TARGET)).rejects.toThrow(/zero output/);
  });

  it("throws when no quotes come back at all", async () => {
    const backend: QuoteBackend = {
      async getQuoteV2() {
        return { quotes: [] };
      },
    };
    await expect(computeQuote(backend, btc, TARGET)).rejects.toThrow(/No quote available/);
  });

  it("formatted amount ceil-rounds, so a manual sender never underpays", async () => {
    const { backend } = rateBackend(RATE);
    const quote = await computeQuote(backend, btc, TARGET);
    // 132562 sats, 8 decimals: exact representation, no loss
    expect(quote.source.formatted).toBe("0.00132562");
    // when a decimal cap forces rounding, it rounds up:
    expect(formatSourceAmount(btc, quote.source.amount, { maxDecimals: 5 })).toBe("0.00133");
    // re-parse the capped display amount: it is >= the required base units
    expect(BigInt(0.00133e8)).toBeGreaterThanOrEqual(quote.source.amount);
  });
});

describe("pickRegularQuote", () => {
  it("prefers the REGULAR quote", () => {
    const dca = { type: "DCA", egressAmount: "1" };
    const regular = { type: "REGULAR", egressAmount: "2" };
    expect(pickRegularQuote([dca, regular])).toBe(regular);
  });

  it("falls back to the first quote when no REGULAR exists", () => {
    const dca = { type: "DCA", egressAmount: "1" };
    expect(pickRegularQuote([dca])).toBe(dca);
  });

  it("returns null on an empty list", () => {
    expect(pickRegularQuote([])).toBeNull();
  });
});
