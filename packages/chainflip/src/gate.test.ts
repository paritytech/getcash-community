import { describe, expect, it } from "vitest";
import { createLiquidityGate } from "./gate";
import type { EgressConfig } from "./quote";
import type { QuoteBackend } from "./quote";
import { SOURCE_CONFIG_BY_ID } from "./sources";

const btc = SOURCE_CONFIG_BY_ID.get("btc")!;
const eth = SOURCE_CONFIG_BY_ID.get("eth")!;

/** Counting backend that always quotes generously (every gate passes). */
function countingBackend() {
  let count = 0;
  const backend: QuoteBackend = {
    async getQuoteV2(args) {
      count++;
      // egress = amount * 1e9; always dwarfs the 250 DOT gate + overhead
      return {
        quotes: [
          {
            type: "REGULAR",
            egressAmount: (BigInt(args.amount) * 1_000_000_000n).toString(),
            ingressAmount: args.amount,
          },
        ],
      };
    },
  };
  return { backend, calls: () => count };
}

describe("liquidity gate", () => {
  it("dedups concurrent in-flight probes: one computeQuote pass total", async () => {
    const { backend, calls } = countingBackend();
    const gate = createLiquidityGate(backend);

    const [a, b] = await Promise.all([gate.probe(btc), gate.probe(btc)]);
    expect(a).toEqual({ status: "available" });
    expect(b).toEqual({ status: "available" });
    // one computeQuote = 1 reference + 1 precise quote
    expect(calls()).toBe(2);
  });

  it("caches the verdict per gate instance; a fresh instance re-probes", async () => {
    const { backend, calls } = countingBackend();
    const gate = createLiquidityGate(backend);

    await gate.probe(btc);
    expect(calls()).toBe(2);
    await gate.probe(btc); // cached; no new backend traffic
    expect(calls()).toBe(2);
    await gate.probe(eth); // different source; its own probe
    expect(calls()).toBe(4);

    const freshGate = createLiquidityGate(backend);
    await freshGate.probe(btc); // per-instance cache, not module-level
    expect(calls()).toBe(6);
  });

  it("reports unavailable (with reason) when the backend throws, and caches that too", async () => {
    let count = 0;
    const backend: QuoteBackend = {
      async getQuoteV2() {
        count++;
        throw new Error("pool too thin");
      },
    };
    const gate = createLiquidityGate(backend);

    const verdict = await gate.probe(btc);
    expect(verdict).toEqual({ status: "unavailable", reason: "pool too thin" });
    expect(count).toBe(1);

    const again = await gate.probe(btc);
    expect(again.status).toBe("unavailable");
    expect(count).toBe(1); // failure verdict cached; no re-probe
  });

  it("gate threshold scales to the egress decimals and honors an explicit override", async () => {
    const amounts: string[] = [];
    const backend: QuoteBackend = {
      async getQuoteV2(args) {
        amounts.push(args.amount);
        return {
          quotes: [
            {
              type: "REGULAR",
              egressAmount: (BigInt(args.amount) * 10_000_000n).toString(),
              ingressAmount: args.amount,
            },
          ],
        };
      },
    };
    const usdt: EgressConfig = { chain: "Assethub", asset: "USDT", decimals: 6 };

    await createLiquidityGate(backend, usdt).probe(btc);
    // Default depth = 250 whole 6-dec units = 250e6; rate 1:1e7, zero non-DOT overhead
    // -> src 25, x1.05 buffer = 26.
    expect(amounts[1]).toBe("26");

    amounts.length = 0;
    await createLiquidityGate(backend, usdt, 100_000_000n).probe(btc);
    // Explicit override 100e6 -> src 10, x1.05 = 10 (bigint floor).
    expect(amounts[1]).toBe("10");
  });
});
