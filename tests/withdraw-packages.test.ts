import { describe, expect, it, vi } from "vitest";
import {
  availableFundingRoutes,
  getcashWithdrawPackages,
  loadFundingPackage,
  resolveFundingRoute,
} from "../app/funding/packages";

// vitest has no Vue plugin, and this test never renders the screens the registries bundle.
vi.mock("../app/components/funding/routes/MeldFundingStatusRoute.vue", () => ({ default: {} }));
vi.mock("../app/components/funding/routes/ChainflipFundingStatusRoute.vue", () => ({
  default: {},
}));
vi.mock("../app/components/withdraw/routes/CryptoWithdrawRoute.vue", () => ({
  default: { name: "CryptoWithdrawRoute" },
}));

describe("getcash withdrawal packages", () => {
  it("offers crypto only; card and bank resolve to unavailable", () => {
    const crypto = resolveFundingRoute(getcashWithdrawPackages, "crypto");
    expect(crypto.kind).toBe("available");
    if (crypto.kind === "available") {
      expect(crypto.package.packageId).toBe("@getsome/withdraw-crypto");
    }
    expect(resolveFundingRoute(getcashWithdrawPackages, "card")).toEqual({
      kind: "unavailable",
      route: "card",
    });
    expect(resolveFundingRoute(getcashWithdrawPackages, "bank")).toEqual({
      kind: "unavailable",
      route: "bank",
    });
    expect(availableFundingRoutes(getcashWithdrawPackages, ["crypto", "card", "bank"])).toEqual([
      "crypto",
    ]);
  });

  it("loads the crypto package for a crypto selection and none for a card one", async () => {
    const loaded = await loadFundingPackage(getcashWithdrawPackages, {
      amount: "25",
      route: "crypto",
    });
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind === "loaded") {
      expect(loaded.component).toEqual({ name: "CryptoWithdrawRoute" });
    }
    const card = await loadFundingPackage(getcashWithdrawPackages, { amount: "25", route: "card" });
    expect(card.kind).toBe("unavailable");
  });
});
