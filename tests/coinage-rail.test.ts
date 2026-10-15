// Which rail a source runs on in the live world: Chainflip's for a swap source, delivering the
// route's deposit token to the burner, and the manual rail for a direct deposit or a fiat source.

import { describe, expect, it, vi } from "vitest";
import type { GetQuoteV2Args } from "@getsome/chainflip";
import type { ConversionRoute } from "@getsome/funding";

const { asked } = vi.hoisted(() => ({ asked: [] as GetQuoteV2Args[] }));
vi.mock("../lib/chainflip-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chainflip-backend")>()),
  // Chainflip at a linear rate, recording what it was asked for.
  mainnetSdk: async () => ({
    getQuoteV2: async (args: GetQuoteV2Args) => {
      asked.push(args);
      const egress = (BigInt(args.amount) * 4_000_000n).toString();
      return { quotes: [{ type: "REGULAR", egressAmount: egress, ingressAmount: args.amount }] };
    },
    requestDepositAddressV2: async () => ({}),
    getStatusV2: async () => ({}),
    getSwapLimits: async () => ({ minimumSwapAmounts: {} }),
  }),
}));

import { railFor } from "../lib/coinage";

const POOL: ConversionRoute = { tier: "pool" };
const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 0 };

describe("railFor", () => {
  it("runs a swap source on Chainflip, delivering the token the route deposits", async () => {
    asked.length = 0;
    const native = await railFor("btc", POOL);
    await native.getQuote({ sourceId: "btc", target: { amount: 10n ** 12n, decimals: 10 } });
    expect(asked[0]).toMatchObject({ srcAsset: "BTC", destChain: "Assethub", destAsset: "DOT" });

    asked.length = 0;
    const stable = await railFor("btc", PSM);
    await stable.getQuote({ sourceId: "btc", target: { amount: 100_000_000n, decimals: 6 } });
    expect(asked[0]).toMatchObject({ srcAsset: "BTC", destChain: "Assethub", destAsset: "USDT" });
  });

  it("refuses a route whose token Chainflip cannot deliver", async () => {
    await expect(railFor("btc", { tier: "pool", external: "USDC" })).rejects.toThrow(
      "Chainflip cannot deliver USDC",
    );
  });

  it("runs every other source on the manual rail for the route's token", async () => {
    expect((await railFor("usdt-assethub", PSM)).sources()[0]?.sourceId).toBe("usdt-assethub");
    expect((await railFor("meld-card", POOL)).sources()[0]?.sourceId).toBe("dot-assethub");
  });
});
