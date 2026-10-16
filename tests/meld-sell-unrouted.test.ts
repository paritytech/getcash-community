// A region whose payout only a lane this build does not sell routes: greyed in the picker, and the
// quote says the payout isn't available there, never a passing failure worth retrying.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportedCorridor } from "../lib/supported";

const corridors = new Map<string, SupportedCorridor>();
const getSellQuote = vi.fn();
const sizeSwapSale = vi.fn();

vi.mock("../app/utils/locale", () => ({ localeCountry: () => "DE" }));
vi.mock("../app/withdraw/meld-client", async () => {
  const { TEST_MELD_ASSETS } = await import("./setup-meld-assets");
  return { meldSellClient: () => ({ getSellQuote, getAssets: async () => TEST_MELD_ASSETS }) };
});
vi.mock("../lib/withdraw-live", () => ({ sizeSwapSale, sizeMeldCommitment: vi.fn() }));
vi.mock("../lib/supported", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/supported")>()),
  fetchOfframpCorridors: async () => corridors,
  fetchOfframpCorridor: async (cc: string) => corridors.get(cc) ?? null,
}));

const card = (code: string, chain: string): SupportedCorridor["methods"][number] => ({
  paymentMethodType: "PAYOUT_TO_CARD",
  category: "card",
  min: "10",
  max: "5000",
  currency: "EUR",
  providers: [],
  lanes: [{ code, chain }],
});

async function quoteFor(lanes: string) {
  vi.stubEnv("VITE_OFFRAMP_LANES", lanes);
  vi.resetModules();
  const { useMeldSellQuote } = await import("../app/composables/useMeldSellQuote");
  const sale = useMeldSellQuote("card", 1_000_000n);
  await sale.loadCatalog();
  await sale.refresh();
  return sale;
}

describe("a region only a swap routes", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    corridors.clear();
    corridors.set("DE", {
      country: "DE",
      fiat: "EUR",
      methods: [card("USDC_ARBITRUM", "arbitrum")],
    });
    corridors.set("FR", {
      country: "FR",
      fiat: "EUR",
      methods: [card("DOT", "assethub")],
    });
    getSellQuote.mockReset();
    sizeSwapSale.mockReset();
  });

  it("reads as not available there when the build sells no swap", async () => {
    const sale = await quoteFor("usdt@assethub,dot@assethub");
    expect(sale.errorKind.value).toBe("unrouted");
    expect(sale.error.value).toBe("Card payout isn't available in this region");
    expect(sale.corridors.value?.get("DE")?.methods).toEqual([]);
    expect(sale.corridors.value?.get("FR")?.methods).toHaveLength(1);
    expect(sizeSwapSale).not.toHaveBeenCalled();
    expect(getSellQuote).not.toHaveBeenCalled();
  });

  it("tries the swap when the build lists it", async () => {
    sizeSwapSale.mockRejectedValue(new Error("no channel"));
    const sale = await quoteFor("dot@assethub,usdc@arbitrum");
    expect(sizeSwapSale).toHaveBeenCalledOnce();
    expect(sale.errorKind.value).toBe("rate");
  });
});
