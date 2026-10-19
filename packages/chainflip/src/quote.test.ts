import { describe, expect, it } from "vitest";
import { TOKENS } from "@getsome/core";
import {
  chainflipTokenOf,
  CHANNEL_SLIPPAGE_FLOOR_PCT,
  channelSlippagePct,
  computeQuote,
  egressFor,
  ON_CHAIN_OVERHEAD_PLANCKS,
  pickRegularQuote,
  SourceMinimumNotMetError,
  withSourceBuffer,
  worstFill,
  type QuoteBackend,
} from "./quote";
import { SOURCE_CONFIG_BY_ID, formatSourceAmount } from "./sources";
import { BelowMinimumSwapAmountError, type GetQuoteV2Args } from "./sdk";

const btc = SOURCE_CONFIG_BY_ID.get("btc")!;
const usdcSolana = SOURCE_CONFIG_BY_ID.get("usdc-solana")!;

/** What the worst fill must clear: the need and a quarter point, rounded up. */
const requiredFor = (need: bigint): bigint => need + (need * 25n + 9_999n) / 10_000n;

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

// srcNeededExact = 505e9 * 250000 / 1e12 = 126250; with no recommendation the channel tolerates
// 0.5%, so its worst fill keeps 99.5% and must clear the need by 0.25%:
// 126250 x 1.0025 / 0.995 = 127201.63 -> 127202 (rounded up)
const EXPECTED_FIRST_PRECISE = 127_202n;

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
    // The floor was quoted, to see that it covers this purchase on its own, and not bought.
    expect(amounts).toEqual([btc.referenceAmountBaseUnits, "1000", "40000"]);
  });

  it("quotes the floor when a guess falls under it, and buys from there when the purchase needs more", async () => {
    // A flat 0.2 DOT fee the reference rate spreads thin: the guess for 15.7 DOT lands under
    // the floor, while what 15.7 DOT really needs lies just over it.
    const amounts: string[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        amounts.push(args.amount);
        const amount = BigInt(args.amount);
        if (amount < 40_000n) throw new BelowMinimumSwapAmountError(40_000n);
        const egress = (amount * RATE - 2_000_000_000n).toString();
        return { quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: egress }] };
      },
    };

    const quote = await computeQuote(backend, btc, 157_000_000_000n, 0n);
    // 39625 is the guess; the floor's worst fill (157.21 DOT) misses 157.3925 DOT, so the amount
    // is solved again from the floor's own price, aiming a basis point over: 40051.
    expect(amounts).toEqual([btc.referenceAmountBaseUnits, "39625", "40000", "40051"]);
    expect(quote.source.amount).toBe(40_051n);
  });

  it("follows a floor that rose between the guess and the floor's own quote", async () => {
    // A flat 30 DOT fee: the guess for 150 DOT lands under the 40000 floor, which has risen to
    // 45000 by the time it is quoted, while 150 DOT needs a little more than 45000.
    const amounts: string[] = [];
    let floor = 40_000n;
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        amounts.push(args.amount);
        const amount = BigInt(args.amount);
        if (amount < floor) {
          const refused = new BelowMinimumSwapAmountError(floor);
          floor = 45_000n;
          throw refused;
        }
        const egress = (amount * RATE - 30_000_000_000n).toString();
        return { quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: egress }] };
      },
    };

    const quote = await computeQuote(backend, btc, 150_000_000_000n, 0n);
    // 45000's worst fill is 149.25 DOT against 150.375; solved from its price, 45344 covers with
    // room to spare, and the line between the two tightens it to 45287, which covers too.
    expect(amounts).toEqual([
      btc.referenceAmountBaseUnits,
      "38951",
      "40000",
      "45000",
      "45344",
      "45287",
    ]);
    expect(quote.source.amount).toBe(45_287n);
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

  it("accepts on the first precise quote when its worst fill covers target + overhead", async () => {
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
    // the worst fill the half-point channel accepts still covers the target + overhead
    expect(worstFill(quote.raw as Record<string, unknown>, 0.5)).toBeGreaterThanOrEqual(
      requiredFor(TOTAL_NEEDED),
    );
  });

  it("buffers the rate-derived source amount for the channel's tolerance and a quarter point", async () => {
    const { backend, calls } = rateBackend(RATE);
    await computeQuote(backend, btc, TARGET);
    const srcNeededExact = (TOTAL_NEEDED * 250_000n) / 1_000_000_000_000n;
    expect(calls[1]?.amount).toBe(withSourceBuffer(srcNeededExact, 0.5).toString());
    expect(calls[1]?.amount).toBe("127202");
  });

  it("buffers by the pair's own recommendation when Chainflip asks for more, as for BTC", async () => {
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        const egress = (BigInt(args.amount) * RATE).toString();
        return {
          quotes: [
            {
              type: "REGULAR",
              egressAmount: egress,
              ingressAmount: args.amount,
              recommendedSlippageTolerancePercent: "2",
            },
          ],
        };
      },
    };
    await computeQuote(backend, btc, TARGET);
    // 126250 x 1.0025 / 0.98 = 129148.60 -> 129149
    expect(calls[1]?.amount).toBe("129149");
    expect(calls).toHaveLength(2);
  });

  it("judges a precise quote by the tolerance its own channel will ask, not the reference's", async () => {
    // Chainflip recommends more as a swap grows: nothing at the reference amount, 2% at this one.
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        const egress = (BigInt(args.amount) * RATE).toString();
        const quote = { type: "REGULAR", egressAmount: egress, ingressAmount: args.amount };
        return {
          quotes: [
            calls.length === 1 ? quote : { ...quote, recommendedSlippageTolerancePercent: 2 },
          ],
        };
      },
    };

    const quote = await computeQuote(backend, btc, TARGET);
    // 127202 is buffered for half a point; at 2% its worst fill is 498.63 DOT, short of 506.2625,
    // so it is solved again at 2%, a basis point over: 129162, whose worst fill is 506.31504.
    expect(calls.map((c) => c.amount)).toEqual([btc.referenceAmountBaseUnits, "127202", "129162"]);
    expect(quote.source.amount).toBe(129_162n);
  });

  it("resizes a short guess from its own price, not by a flat step", async () => {
    // The purchase's own size swaps 3% worse than the reference amount.
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        if (calls.length === 1) {
          return { quotes: [{ type: "REGULAR", egressAmount: (250_000n * RATE).toString() }] };
        }
        const egress = ((BigInt(args.amount) * RATE * 97n) / 100n).toString();
        return { quotes: [{ type: "REGULAR", egressAmount: egress, ingressAmount: args.amount }] };
      },
    };

    const quote = await computeQuote(backend, btc, TARGET);
    // 127202 delivers 491.0760412 DOT at the worst fill; solved from its price, a basis point
    // over 506.2625: 131149.
    expect(calls.map((c) => c.amount)).toEqual([btc.referenceAmountBaseUnits, "127202", "131149"]);
    expect(quote.source.amount).toBe(131_149n);
  });

  it("converges within its attempts when the pool's own impact grows with the amount", async () => {
    // Twenty times the reference amount moves the price 5% against the swap: a resize aimed at
    // the requirement exactly lands a hair short each time and needs six quotes; aiming a basis
    // point over needs four.
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        const amount = BigInt(args.amount);
        const egress = amount * RATE - (amount * amount * RATE) / 100_000_000n;
        return {
          quotes: [
            { type: "REGULAR", egressAmount: egress.toString(), ingressAmount: args.amount },
          ],
        };
      },
    };

    const quote = await computeQuote(backend, btc, 19_000_000_000_000n);
    expect(calls.map((c) => c.amount)).toEqual([
      btc.referenceAmountBaseUnits,
      "4799061",
      "5028882",
      "5041051",
      "5041697",
    ]);
    expect(quote.source.amount).toBe(5_041_697n);
  });

  describe("tightening a guess that covers with room to spare", () => {
    // A flat 0.2 DOT cost weighs 0.2% at the 250000-sat reference and a tenth of that on 2000 DOT,
    // so the guess from the reference rate covers 2000 DOT with 0.19% to spare.
    const egressFor = (amount: bigint, worse = false) =>
      ((amount * RATE * (worse ? 99n : 100n)) / 100n - 2_000_000_000n).toString();

    it("quotes it once more from its own price, and takes the tighter amount when it covers", async () => {
      const calls: GetQuoteV2Args[] = [];
      const backend: QuoteBackend = {
        async getQuoteV2(args) {
          calls.push(args);
          const egress = egressFor(BigInt(args.amount));
          return {
            quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: egress }],
          };
        },
      };
      const quote = await computeQuote(backend, btc, 20_000_000_000_000n, 0n);
      // The tighter amount's worst fill, 20052.00416 DOT, still covers 20050.
      expect(calls.map((c) => c.amount)).toEqual([
        btc.referenceAmountBaseUnits,
        "5047784",
        "5038692",
      ]);
      expect(quote.source.amount).toBe(5_038_692n);
    });

    it("keeps the covering quote when the tighter one falls short", async () => {
      const calls: GetQuoteV2Args[] = [];
      const backend: QuoteBackend = {
        async getQuoteV2(args) {
          calls.push(args);
          // The price drops a point between the covering quote and the tighter one.
          const egress = egressFor(BigInt(args.amount), calls.length === 3);
          return {
            quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: egress }],
          };
        },
      };
      const quote = await computeQuote(backend, btc, 20_000_000_000_000n, 0n);
      expect(calls).toHaveLength(3);
      expect(quote.source.amount).toBe(5_047_784n);
    });

    it("keeps the covering quote when the tighter one is refused", async () => {
      const calls: GetQuoteV2Args[] = [];
      const backend: QuoteBackend = {
        async getQuoteV2(args) {
          calls.push(args);
          if (calls.length === 3) throw new Error("Chainflip quote request failed (HTTP 503)");
          const egress = egressFor(BigInt(args.amount));
          return {
            quotes: [{ type: "REGULAR", ingressAmount: args.amount, egressAmount: egress }],
          };
        },
      };
      const quote = await computeQuote(backend, btc, 20_000_000_000_000n, 0n);
      expect(quote.source.amount).toBe(5_047_784n);
    });
  });

  it("keeps a fixed ingress fee fixed when it resizes, so a small purchase is not overpriced", async () => {
    // Tron USDT into USDT: a 3.783454 USDT ingress fee, the 0.5 USDC network minimum and a
    // 0.0227 USDT egress fee. Scaling the whole deposit by the shortfall would ask 17.46 USDT for
    // 10 CASH; the least that covers is 14.545020.
    const usdtTron = SOURCE_CONFIG_BY_ID.get("usdt-tron")!;
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        const deposit = BigInt(args.amount);
        const egress = ((deposit - 3_783_454n) * 9_995n) / 10_000n - 500_000n - 22_700n;
        return {
          quotes: [
            {
              type: "REGULAR",
              depositAmount: args.amount,
              egressAmount: egress.toString(),
              includedFees: [
                { type: "INGRESS", chain: "Tron", asset: "USDT", amount: "3783454" },
                { type: "EGRESS", chain: "Assethub", asset: "USDT", amount: "22700" },
              ],
              recommendedSlippageTolerancePercent: 0.5,
            },
          ],
        };
      },
    };

    const usdt = egressFor(chainflipTokenOf(TOKENS.USDT)!);
    const quote = await computeQuote(backend, usdtTron, 10_156_811n, 0n, usdt);
    // Solved from its own price, 14.882695 covers but 2.3% over, the network fee's flat 0.5 USDC
    // counting there as price; the line from the short guess tightens it to 14.546046.
    expect(calls.map((c) => c.amount)).toEqual([
      usdtTron.referenceAmountBaseUnits,
      "10417945",
      "14882695",
      "14546046",
    ]);
    expect(quote.source.amount).toBe(14_546_046n);
  });

  it("prices a small purchase whose fixed fees the reference rate understates", async () => {
    // Solana USDC into USDT: a 0.07285 USDC ingress fee, the 0.5 USDC network minimum and a
    // 0.021924 USDT egress fee, flat, over 5 bps. They cost 0.2% of the 250 USDC reference and
    // 5% of 10 USDC, which a guess from the reference rate and flat 1% steps never caught up with.
    const calls: GetQuoteV2Args[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        calls.push(args);
        const deposit = BigInt(args.amount);
        const egress = ((deposit - 72_850n) * 9_995n) / 10_000n - 500_000n - 21_924n;
        return {
          quotes: [
            {
              type: "REGULAR",
              depositAmount: args.amount,
              egressAmount: egress.toString(),
              includedFees: [
                { type: "INGRESS", chain: "Solana", asset: "USDC", amount: "72850" },
                { type: "NETWORK", chain: "Ethereum", asset: "USDC", amount: "500000" },
                { type: "EGRESS", chain: "Assethub", asset: "USDT", amount: "21924" },
              ],
              recommendedSlippageTolerancePercent: 0.5,
            },
          ],
        };
      },
    };

    const usdt = egressFor(chainflipTokenOf(TOKENS.USDT)!);
    const target = 10_156_811n; // what 10 CASH asks of the PSM, in USDT units
    const quote = await computeQuote(backend, usdcSolana, target, 0n, usdt);
    // The reference, a guess whose worst fill is 9.614621 USDT, that guess solved again from its
    // own price with the fees kept fixed (10.212579 at the worst, 0.3% over), and the line between
    // the two, whose worst fill is 10.183223 against the 10.182204 it needs.
    expect(calls.map((c) => c.amount)).toEqual([
      usdcSolana.referenceAmountBaseUnits,
      "10262916",
      "10864179",
      "10834661",
    ]);
    expect(quote.source.amount).toBe(10_834_661n);
    expect(worstFill(quote.raw as Record<string, unknown>, 0.5)).toBe(10_183_223n);
    expect(10_183_223n).toBeGreaterThanOrEqual(requiredFor(target));
  });

  it("throws a clear error after 6 non-converging precise attempts", async () => {
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
      /BTC amount that covers the target \+ fees after 6 attempts/,
    );
    expect(calls).toHaveLength(7); // 1 ref + 6 precise
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
    // 127202 sats, 8 decimals: exact representation, no loss
    expect(quote.source.formatted).toBe("0.00127202");
    // when a decimal cap forces rounding, it rounds up:
    expect(formatSourceAmount(btc, quote.source.amount, { maxDecimals: 5 })).toBe("0.00128");
    // re-parse the capped display amount: it is >= the required base units
    expect(BigInt(0.00128e8)).toBeGreaterThanOrEqual(quote.source.amount);
  });
});

describe("the channel's tolerance", () => {
  it("is half a point, or the quote's own recommendation when that is higher", () => {
    expect(CHANNEL_SLIPPAGE_FLOOR_PCT).toBe(0.5);
    expect(channelSlippagePct(undefined)).toBe(0.5);
    expect(channelSlippagePct({ recommendedSlippageTolerancePercent: "0.5" })).toBe(0.5);
    expect(channelSlippagePct({ recommendedSlippageTolerancePercent: "0.25" })).toBe(0.5);
    expect(channelSlippagePct({ recommendedSlippageTolerancePercent: "2" })).toBe(2);
    expect(channelSlippagePct({ recommendedSlippageTolerancePercent: "soon" })).toBe(0.5);
  });

  it("buffers a source amount so the worst fill keeps a quarter point over it, rounded up", () => {
    // 10000 x 1.0025 / 0.995 = 10075.38; / 0.98 = 10229.59
    expect(withSourceBuffer(10_000n, 0.5)).toBe(10_076n);
    expect(withSourceBuffer(10_000n, 2)).toBe(10_230n);
    expect(withSourceBuffer(1n, 0.5)).toBe(2n);
    expect(() => withSourceBuffer(10_000n, 100)).toThrow(RangeError);
  });

  it("puts the worst fill at the egress and its fee less the tolerance, less the fee again", () => {
    const quote = {
      egressAmount: "1000000",
      includedFees: [
        { type: "INGRESS", amount: "70000" },
        { type: "EGRESS", amount: "20000" },
      ],
    };
    // 1020000 x 0.995 - 20000
    expect(worstFill(quote, 0.5)).toBe(994_900n);
    // 1020000 x 0.98 - 20000
    expect(worstFill(quote, 2)).toBe(979_600n);
    expect(worstFill({ egressAmount: "1000000" }, 0.5)).toBe(995_000n);
    // A tolerance that accepts any fill guarantees nothing.
    expect(worstFill(quote, 100)).toBe(0n);
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

describe("chainflipTokenOf", () => {
  it("names the tokens Chainflip delivers and none of the others", () => {
    expect(chainflipTokenOf(TOKENS.PAS)?.chainflipAsset).toBe("DOT");
    expect(chainflipTokenOf(TOKENS.USDT)?.chainflipAsset).toBe("USDT");
    expect(chainflipTokenOf(TOKENS.USDC)).toBeUndefined();
  });
});
