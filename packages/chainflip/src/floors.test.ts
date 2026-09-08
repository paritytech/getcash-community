// The floor is learned once per source, at the floor itself, and every amount after that is
// answered locally. Failures stay per source, and none of them throws.

import { describe, expect, it } from "vitest";
import { learnFloors, offerFor, type FloorsBackend, type MinimumSwapAmounts } from "./floors";
import { ChainflipRequestError, type GetQuoteV2Args } from "./sdk";
import { SOURCE_CONFIG_BY_ID } from "./sources";

const BTC = SOURCE_CONFIG_BY_ID.get("btc")!;
const ETH = SOURCE_CONFIG_BY_ID.get("eth")!;
const TRX = SOURCE_CONFIG_BY_ID.get("trx-tron")!;

// Chainflip mainnet, 2026-08-24: 0.0004 BTC, 0.01 ETH; TRX missing.
const MINIMUMS: MinimumSwapAmounts = {
  Bitcoin: { BTC: 40_000n },
  Ethereum: { ETH: 10_000_000_000_000_000n },
};

/** 1 sat -> 4e6 plancks, 1 wei -> 1 planck: the floor is worth 16 DOT of BTC, 1 DOT of ETH. */
const RATE: Record<string, bigint> = { BTC: 4_000_000n, ETH: 1n };

/** A scripted backend. Every quote request is counted, overridden or not. */
function backend(overrides: Partial<FloorsBackend> = {}) {
  const calls: GetQuoteV2Args[] = [];
  let limitsCalls = 0;
  const quote: FloorsBackend["getQuoteV2"] =
    overrides.getQuoteV2 ??
    (async (args) => {
      const rate = RATE[args.srcAsset] ?? 1n;
      return {
        quotes: [
          { type: "DCA", egressAmount: "1" },
          {
            type: "REGULAR",
            egressAmount: (BigInt(args.amount) * rate).toString(),
            estimatedDurationSeconds: 900,
          },
        ],
      };
    });
  const b: FloorsBackend = {
    async getSwapLimits() {
      limitsCalls += 1;
      return { minimumSwapAmounts: MINIMUMS };
    },
    ...overrides,
    async getQuoteV2(args) {
      calls.push(args);
      return quote(args);
    },
  };
  return { backend: b, calls, limitsCalls: () => limitsCalls };
}

describe("learnFloors", () => {
  it("asks the limits once and quotes each source exactly at its minimum", async () => {
    const { backend: b, calls, limitsCalls } = backend();
    const floors = await learnFloors(b, [BTC, ETH]);

    expect(limitsCalls()).toBe(1);
    expect(calls.map((c) => [c.srcChain, c.srcAsset, c.amount, c.destChain, c.destAsset])).toEqual([
      ["Bitcoin", "BTC", "40000", "Assethub", "DOT"],
      ["Ethereum", "ETH", "10000000000000000", "Assethub", "DOT"],
    ]);
    expect(floors.get("btc")).toEqual({
      kind: "floor",
      floor: {
        sourceId: "btc",
        minimumBaseUnits: 40_000n,
        minimumEgressBaseUnits: 160_000_000_000n, // 16 DOT
        etaSeconds: 900,
      },
    });
    expect(floors.get("eth")?.kind).toBe("floor");
  });

  it("marks a source Chainflip does not list as unavailable without asking for a quote", async () => {
    const { backend: b, calls } = backend();
    const floors = await learnFloors(b, [TRX]);
    expect(calls).toHaveLength(0);
    expect(floors.get("trx-tron")).toEqual({
      kind: "unavailable",
      reason: expect.stringContaining("Tron TRX") as unknown as string,
    });
  });

  it("keeps one source's failure to itself", async () => {
    const { backend: b } = backend({
      async getQuoteV2(args) {
        if (args.srcAsset === "BTC")
          throw new Error("Quoting is currently unavailable due to maintenance");
        return {
          quotes: [{ type: "REGULAR", egressAmount: (BigInt(args.amount) * 1n).toString() }],
        };
      },
    });
    const floors = await learnFloors(b, [BTC, ETH]);
    expect(floors.get("btc")).toEqual({
      kind: "unavailable",
      reason: "Quoting is currently unavailable due to maintenance",
    });
    const eth = floors.get("eth");
    expect(eth?.kind).toBe("floor");
    if (eth?.kind === "floor") expect(eth.floor.etaSeconds).toBeNull(); // none given
  });

  it("makes every source unavailable, with the reason, when the limits call fails", async () => {
    const { backend: b, calls } = backend({
      async getSwapLimits() {
        throw new Error("HTTP 503");
      },
    });
    const floors = await learnFloors(b, [BTC, ETH]);
    expect(calls).toHaveLength(0);
    for (const id of ["btc", "eth"] as const) {
      expect(floors.get(id)).toEqual({
        kind: "unavailable",
        reason: expect.stringContaining("HTTP 503") as unknown as string,
      });
    }
  });

  it("asks once, and stops, when Chainflip itself is down", async () => {
    // Maintenance: every quote 503s the same way.
    const { backend: b, calls } = backend({
      async getQuoteV2() {
        throw new ChainflipRequestError(
          "Chainflip quote request failed (HTTP 503): Quoting is currently unavailable due to maintenance",
          503,
        );
      },
    });
    const floors = await learnFloors(b, [BTC, ETH]);
    expect(calls).toHaveLength(1);
    for (const id of ["btc", "eth"] as const) {
      expect(floors.get(id)).toEqual({
        kind: "unavailable",
        reason: expect.stringContaining("maintenance") as unknown as string,
      });
    }
  });

  it("treats no response at all as an outage too", async () => {
    const { backend: b, calls } = backend({
      async getQuoteV2() {
        throw new ChainflipRequestError("Chainflip quote request failed: Network Error", undefined);
      },
    });
    const floors = await learnFloors(b, [BTC, ETH]);
    expect(calls).toHaveLength(1);
    expect(floors.get("eth")?.kind).toBe("unavailable");
  });

  it("does not let one asset's 4xx speak for the others", async () => {
    const { backend: b, calls } = backend({
      async getQuoteV2(args) {
        if (args.srcAsset === "BTC") {
          throw new ChainflipRequestError(
            "Chainflip quote request failed (HTTP 400): asset disabled",
            400,
          );
        }
        return { quotes: [{ type: "REGULAR", egressAmount: args.amount }] };
      },
    });
    const floors = await learnFloors(b, [BTC, ETH]);
    expect(calls).toHaveLength(2);
    expect(floors.get("btc")?.kind).toBe("unavailable");
    expect(floors.get("eth")?.kind).toBe("floor");
  });

  it("treats a quote with no output as unavailable", async () => {
    const { backend: b } = backend({
      async getQuoteV2() {
        return { quotes: [] };
      },
    });
    const floors = await learnFloors(b, [BTC]);
    expect(floors.get("btc")?.kind).toBe("unavailable");
  });
});

describe("offerFor", () => {
  const floor = {
    sourceId: "btc" as const,
    minimumBaseUnits: 40_000n,
    minimumEgressBaseUnits: 160_000_000_000n, // 16 DOT
    etaSeconds: 900,
  };

  it("is available from the floor's worth upward, and not below it", () => {
    expect(offerFor(BTC, floor, 160_000_000_000n).available).toBe(true);
    expect(offerFor(BTC, floor, 200_000_000_000n).available).toBe(true);
    expect(offerFor(BTC, floor, 159_999_999_999n).available).toBe(false);
  });

  it("does not let the slippage buffer argue a purchase over the floor", () => {
    // 4% under the floor's worth: inside the 5% buffer, still unavailable.
    expect(offerFor(BTC, floor, 153_600_000_000n).available).toBe(false);
  });

  it("scales the send amount linearly from the floor, buffered like the precise quote", () => {
    // Twice the floor's worth -> twice the minimum, plus 5%.
    const offer = offerFor(BTC, floor, 320_000_000_000n);
    expect(offer.sendBaseUnits).toBe(84_000n);
    expect(offer.sendFormatted).toBe("0.00084");
    expect(offer.etaSeconds).toBe(900);
    expect(offer.minimumEgressBaseUnits).toBe(160_000_000_000n);
  });

  it("rounds the exact amount up, never down", () => {
    // 1 planck over an exact multiple must not vanish into the division.
    const offer = offerFor(BTC, floor, 160_000_000_001n);
    expect(offer.sendBaseUnits).toBeGreaterThan(42_000n);
  });

  it("adds the on-chain overhead to what must be covered", () => {
    expect(offerFor(BTC, floor, 100_000_000_000n, 60_000_000_000n).available).toBe(true);
    expect(offerFor(BTC, floor, 100_000_000_000n, 0n).available).toBe(false);
  });

  it("caps display decimals when asked", () => {
    const offer = offerFor(BTC, floor, 320_000_000_000n, 0n, { maxDecimals: 4 });
    expect(offer.sendFormatted).toBe("0.0009"); // ceil of 0.00084 at 4 places
  });
});
