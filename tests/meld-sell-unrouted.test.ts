// A region whose payout only a lane this build does not sell routes: greyed in the picker, and the
// quote says the payout isn't available there, never a passing failure worth retrying.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleVaultProxyTarget, SupportedCorridor } from "../lib/supported";

const corridors = new Map<string, SupportedCorridor>();
const getSellQuote = vi.fn();
const sizeSwapSale = vi.fn();
const fetchCorridors = vi.fn();
const FACTORY = `0x${"11".repeat(20)}`;
const IMPLEMENTATION = `0x${"22".repeat(20)}`;
const NAMED: SaleVaultProxyTarget = {
  chain: "arbitrum",
  chainId: 421614,
  factory: FACTORY,
  implementation: IMPLEMENTATION,
};
let named: SaleVaultProxyTarget | null = NAMED;
const LINE = { serviceProvider: "TRANSAK", sourceAmount: "2", destinationAmount: "1.8" };

vi.mock("../app/utils/locale", () => ({ localeCountry: () => "DE" }));
vi.mock("../app/withdraw/meld-client", async () => {
  const { TEST_MELD_ASSETS } = await import("./setup-meld-assets");
  return { meldSellClient: () => ({ getSellQuote, getAssets: async () => TEST_MELD_ASSETS }) };
});
vi.mock("../lib/withdraw-live", () => ({ sizeSwapSale, sizeMeldCommitment: vi.fn() }));
vi.mock("../lib/supported", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/supported")>()),
  fetchOfframpCorridors: () => fetchCorridors(),
  fetchOfframpCorridor: async (cc: string) => corridors.get(cc) ?? null,
  getOfframpSaleVaultProxy: () => named,
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

/** Builds with this SaleVaultProxy deployment, or none. */
function deployedAt(factory: string | null): void {
  vi.stubEnv("VITE_SALE_VAULT_PROXY_FACTORY", factory ?? "");
  vi.stubEnv("VITE_SALE_VAULT_PROXY_IMPLEMENTATION", factory === null ? "" : IMPLEMENTATION);
}

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
    fetchCorridors.mockReset().mockImplementation(async () => corridors);
    named = NAMED;
    deployedAt(FACTORY);
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

  it("quotes the swap with the SaleVaultProxy the build and the adapter both name", async () => {
    sizeSwapSale.mockResolvedValue({ promise: 2_000_000n, route: { tier: "psm" } });
    getSellQuote.mockResolvedValue({ quotes: [LINE] });
    const sale = await quoteFor("usdc@arbitrum");
    expect(getSellQuote).toHaveBeenCalledOnce();
    expect(sale.quote.value?.swap).toEqual({
      lane: "usdc-arbitrum",
      route: { tier: "psm" },
      proxy: NAMED,
    });
  });

  it("quotes a swap that commits exactly the deployment's least sale", async () => {
    sizeSwapSale.mockResolvedValue({ promise: 1_250_000n, route: { tier: "psm" } });
    getSellQuote.mockResolvedValue({ quotes: [LINE] });
    const sale = await quoteFor("usdc@arbitrum");
    expect(sale.quote.value?.cryptoAmount).toBe(1_250_000n);
  });

  it("skips the swap when the build has no SaleVaultProxy deployment", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deployedAt(null);
    const sale = await quoteFor("usdc@arbitrum");
    expect(sizeSwapSale).not.toHaveBeenCalled();
    expect(sale.error.value).toBe(
      "Card and bank sales through Arbitrum are not available on this network.",
    );
    vi.restoreAllMocks();
  });

  it("skips the swap when the adapter names another SaleVaultProxy, or none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    named = { ...NAMED, factory: `0x${"33".repeat(20)}` };
    await quoteFor("usdc@arbitrum");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the adapter names SaleVaultProxy/));
    named = null;
    await quoteFor("usdc@arbitrum");
    expect(sizeSwapSale).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("reads the catalog again once the adapter names its SaleVaultProxy, and quotes the swap", async () => {
    sizeSwapSale.mockResolvedValue({ promise: 2_000_000n, route: { tier: "psm" } });
    getSellQuote.mockResolvedValue({ quotes: [LINE] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Before the adapter verified its deployment it names none and drops the Arbitrum lane
    let verified = false;
    fetchCorridors.mockImplementation(async () => {
      named = verified ? NAMED : null;
      return verified ? corridors : new Map([["FR", corridors.get("FR")!]]);
    });
    const sale = await quoteFor("usdc@arbitrum");
    expect(sale.quote.value).toBeNull();
    verified = true;
    await sale.refresh();
    expect(sale.quote.value?.swap?.proxy).toEqual(NAMED);
    // Named now, the catalog is not read again
    const reads = fetchCorridors.mock.calls.length;
    await sale.refresh();
    expect(fetchCorridors).toHaveBeenCalledTimes(reads);
    vi.restoreAllMocks();
  });

  it("skips the swap below the deployment's least sale", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sizeSwapSale.mockResolvedValue({ promise: 1_000_000n, route: { tier: "psm" } });
    const sale = await quoteFor("usdc@arbitrum");
    expect(getSellQuote).not.toHaveBeenCalled();
    expect(sale.errorKind.value).toBe("rate");
    vi.restoreAllMocks();
  });
});
