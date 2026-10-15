import { describe, expect, it, vi } from "vitest";
import {
  availableFundingRoutes,
  getcashWithdrawPackages,
  loadFundingPackage,
  resolveFundingRoute,
  uniqueFundingPackages,
} from "../app/funding/packages";

// vitest has no Vue plugin, and this test never renders the screens the registries bundle.
vi.mock("../app/components/funding/routes/MeldFundingStatusRoute.vue", () => ({ default: {} }));
vi.mock("../app/components/funding/routes/ChainflipFundingStatusRoute.vue", () => ({
  default: {},
}));
vi.mock("../app/components/withdraw/routes/CryptoWithdrawRoute.vue", () => ({
  default: { name: "CryptoWithdrawRoute" },
}));
vi.mock("../app/components/withdraw/routes/MeldWithdrawRoute.vue", () => ({
  default: { name: "MeldWithdrawRoute" },
}));

describe("getcash withdrawal packages", () => {
  it("offers crypto through its own package and card and bank through the fiat sale's", () => {
    const crypto = resolveFundingRoute(getcashWithdrawPackages, "crypto");
    expect(crypto.kind).toBe("available");
    if (crypto.kind === "available") {
      expect(crypto.package.packageId).toBe("@getsome/withdraw-crypto");
    }
    for (const route of ["card", "bank"] as const) {
      const fiat = resolveFundingRoute(getcashWithdrawPackages, route);
      expect(fiat.kind).toBe("available");
      if (fiat.kind === "available") expect(fiat.package.packageId).toBe("@getsome/withdraw-meld");
    }
    expect(availableFundingRoutes(getcashWithdrawPackages, ["crypto", "card", "bank"])).toEqual([
      "crypto",
      "card",
      "bank",
    ]);
  });

  it("keeps card and bank unavailable in a build that does not sell for fiat yet", async () => {
    vi.resetModules();
    vi.doMock("../lib/config", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      MELD_SELL_ENABLED: false,
    }));
    const live = await import("../app/funding/packages");
    expect(
      live.availableFundingRoutes(live.getcashWithdrawPackages, ["crypto", "card", "bank"]),
    ).toEqual(["crypto"]);
    vi.doUnmock("../lib/config");
    vi.resetModules();
  });

  it("shares one fiat package between card and bank, so the list asks it once", () => {
    expect(uniqueFundingPackages(getcashWithdrawPackages).map((p) => p.packageId)).toEqual([
      "@getsome/withdraw-crypto",
      "@getsome/withdraw-meld",
    ]);
  });

  it("loads the crypto package for a crypto selection and the fiat sale's for a card one", async () => {
    const loaded = await loadFundingPackage(getcashWithdrawPackages, {
      amount: "25",
      route: "crypto",
    });
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind === "loaded") {
      expect(loaded.component).toEqual({ name: "CryptoWithdrawRoute" });
    }
    const card = await loadFundingPackage(getcashWithdrawPackages, { amount: "25", route: "card" });
    expect(card.kind).toBe("loaded");
    if (card.kind === "loaded") expect(card.component).toEqual({ name: "MeldWithdrawRoute" });
  });
});
