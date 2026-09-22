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
vi.mock("../app/components/withdraw/routes/MeldWithdrawRoute.vue", () => ({
  default: { name: "MeldWithdrawRoute" },
}));

describe("getcash withdrawal packages", () => {
  it("offers crypto, card and bank; card and bank share one Meld package", () => {
    const crypto = resolveFundingRoute(getcashWithdrawPackages, "crypto");
    expect(crypto.kind).toBe("available");
    if (crypto.kind === "available") {
      expect(crypto.package.packageId).toBe("@getsome/withdraw-crypto");
    }
    const card = resolveFundingRoute(getcashWithdrawPackages, "card");
    const bank = resolveFundingRoute(getcashWithdrawPackages, "bank");
    expect(card.kind).toBe("available");
    expect(bank.kind).toBe("available");
    if (card.kind === "available" && bank.kind === "available") {
      expect(card.package.packageId).toBe("@getsome/withdraw-meld");
      // The same package instance, the way the buy side shares one across its own card and bank.
      expect(card.package).toBe(bank.package);
    }
    expect(availableFundingRoutes(getcashWithdrawPackages, ["crypto", "card", "bank"])).toEqual([
      "crypto",
      "card",
      "bank",
    ]);
  });

  it("loads the crypto package for a crypto selection and the Meld one for a card selection", async () => {
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
    if (card.kind === "loaded") {
      expect(card.component).toEqual({ name: "MeldWithdrawRoute" });
    }
  });
});
