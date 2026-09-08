// Learning the floors: every offered source gets an answer, the wait has a ceiling, and
// nothing here throws.

import { describe, expect, it } from "vitest";
import type { FloorsBackend } from "@getsome/chainflip";
import { learnSourceFloors, OFFERED_SOURCE_IDS } from "../lib/source-floors";

const backend: FloorsBackend = {
  async getSwapLimits() {
    return {
      minimumSwapAmounts: {
        Bitcoin: { BTC: 40_000n },
        Ethereum: { ETH: 10_000_000_000_000_000n, USDC: 20_000_000n, USDT: 20_000_000n },
        Solana: { SOL: 68_000_000n, USDC: 10_000_000n, USDT: 10_000_000n },
        Tron: { TRX: 30_000_000n, USDT: 10_000_000n },
      },
    };
  },
  async getQuoteV2(args) {
    return { quotes: [{ type: "REGULAR", egressAmount: (BigInt(args.amount) * 10n).toString() }] };
  },
};

describe("learnSourceFloors", () => {
  it("offers exactly the UI catalog's nine sources", () => {
    expect([...OFFERED_SOURCE_IDS].sort()).toEqual(
      [
        "btc",
        "eth",
        "usdc-eth",
        "usdt-eth",
        "sol-solana",
        "usdc-solana",
        "usdt-solana",
        "trx-tron",
        "usdt-tron",
      ].sort(),
    );
  });

  it("answers for every offered source", async () => {
    const floors = await learnSourceFloors({ backend });
    expect([...floors.keys()].sort()).toEqual([...OFFERED_SOURCE_IDS].sort());
    for (const result of floors.values()) expect(result.kind).toBe("floor");
  });

  it("gives up rather than holding the network screen open forever", async () => {
    const started = Date.now();
    const floors = await learnSourceFloors({
      timeoutMs: 50,
      backend: { ...backend, getSwapLimits: () => new Promise(() => {}) }, // never answers
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(floors.size).toBe(OFFERED_SOURCE_IDS.length);
    for (const result of floors.values()) {
      expect(result).toEqual({
        kind: "unavailable",
        reason: expect.stringMatching(/timed out/) as unknown as string,
      });
    }
  });

  it("learns only the sources asked for", async () => {
    const floors = await learnSourceFloors({ backend, sourceIds: ["btc", "usdt-tron"] });
    expect([...floors.keys()].sort()).toEqual(["btc", "usdt-tron"]);
  });
});
