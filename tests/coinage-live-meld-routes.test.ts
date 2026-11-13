// A card or bank top-up asks its provider for USDT through the PSM, then DOT, then USDC.

import { describe, expect, it, vi } from "vitest";
import type { ConversionRoute } from "@getsome/funding";

const PSM: ConversionRoute = { tier: "psm", external: "USDT", feeRate: 1_000 };
const POOL: ConversionRoute = { tier: "pool" };
const USDC_POOL: ConversionRoute = { tier: "pool", external: "USDC" };

vi.mock("../lib/host-chain", () => ({
  ASSET_HUB: "asset-hub",
  PEOPLE: "people",
  ASSET_HUB_GENESIS: "0xah",
  PEOPLE_GENESIS: "0xpe",
  connectChain: async () => ({ getTypedApi: () => ({}) }),
}));
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getsome/funding")>()),
  rankRoutes: async (_api: unknown, query: { deposit?: string }) =>
    query.deposit === "USDC" ? [USDC_POOL] : [PSM, POOL],
}));

describe("rankMeldRoutes", () => {
  it("ranks USDC after the fiat rails' own order", async () => {
    const { rankMeldRoutes } = await import("../lib/coinage-live");
    expect(await rankMeldRoutes(50_000_000n)).toEqual([PSM, POOL, USDC_POOL]);
  });
});
