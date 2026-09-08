import { describe, expect, it, vi } from "vitest";
import type { Component } from "vue";
import {
  availableFundingRoutes,
  uniqueFundingPackages,
  getcashRoutePackages,
  loadFundingPackage,
  loadFundingTopUpPackage,
  resolveFundingRoute,
  type FundingRoutePackages,
} from "../app/funding/packages";
import {
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  projectFundingProgress,
} from "../app/funding/progress";
import { resolveFundingTopUpDestination } from "../app/funding/navigation";
import type { FundingSelection } from "../app/funding/selection";
import type { FundingTopUp } from "../app/funding/top-ups";

const progress = projectFundingProgress({
  snapshot: createFundingProgressSnapshot(chainflipProgressProvider.createProfile()),
  createdAt: 0,
  now: 0,
});

describe("getcash funding packages", () => {
  it("maps crypto explicitly to the Chainflip package", () => {
    const resolution = resolveFundingRoute(getcashRoutePackages, "crypto");
    expect(resolution.kind).toBe("available");
    if (resolution.kind === "available") {
      expect(resolution.package.packageId).toBe("@getsome/chainflip");
    }
  });

  it("maps card and bank to one Meld package", () => {
    const card = resolveFundingRoute(getcashRoutePackages, "card");
    const bank = resolveFundingRoute(getcashRoutePackages, "bank");
    expect(card.kind).toBe("available");
    expect(bank.kind).toBe("available");
    if (card.kind === "available" && bank.kind === "available") {
      expect(card.package.packageId).toBe("@getsome/meld");
      // The same object under both keys.
      expect(card.package).toBe(bank.package);
    }
    expect(uniqueFundingPackages(getcashRoutePackages)).toHaveLength(2);
  });

  it("leaves a route without a package entrypoint unavailable", () => {
    expect(resolveFundingRoute({}, "bank")).toEqual({ kind: "unavailable", route: "bank" });
  });

  it("does not load a package while resolving its route", () => {
    const load = vi.fn(async () => ({}) as Component);
    const packages = {
      bank: { packageId: "bank-package", load },
    } satisfies FundingRoutePackages;

    const resolution = resolveFundingRoute(packages, "bank");
    expect(resolution.kind).toBe("available");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads only the package selected by the handoff", async () => {
    const component = {} as Component;
    const bankLoad = vi.fn(async () => component);
    const cryptoLoad = vi.fn(async () => component);
    const packages = {
      bank: { packageId: "bank-package", load: bankLoad },
      crypto: { packageId: "@getsome/chainflip", load: cryptoLoad },
    } satisfies FundingRoutePackages;
    const selection = Object.freeze({ amount: "42.5", route: "crypto" }) satisfies FundingSelection;

    const result = await loadFundingPackage(packages, selection);

    expect(result).toMatchObject({
      kind: "loaded",
      selection: { amount: "42.5", route: "crypto" },
      packageId: "@getsome/chainflip",
    });
    expect(result.selection).toBe(selection);
    expect(bankLoad).not.toHaveBeenCalled();
    expect(cryptoLoad).toHaveBeenCalledOnce();
  });

  it("does not load another package when a route is unavailable", async () => {
    const cryptoLoad = vi.fn(async () => ({}) as Component);
    const packages = {
      crypto: { packageId: "@getsome/chainflip", load: cryptoLoad },
    } satisfies FundingRoutePackages;
    const selection = Object.freeze({ amount: "20", route: "card" }) satisfies FundingSelection;

    await expect(loadFundingPackage(packages, selection)).resolves.toEqual({
      kind: "unavailable",
      selection,
    });
    expect(cryptoLoad).not.toHaveBeenCalled();
  });

  it("returns package loading failures without changing the selection", async () => {
    const failure = new Error("chunk unavailable");
    const packages = {
      bank: { packageId: "bank-package", load: vi.fn(async () => Promise.reject(failure)) },
    } satisfies FundingRoutePackages;
    const selection = Object.freeze({ amount: "25", route: "bank" }) satisfies FundingSelection;

    await expect(loadFundingPackage(packages, selection)).resolves.toEqual({
      kind: "failed",
      selection,
      packageId: "bank-package",
      error: failure,
    });
  });

  it("loads status from the package that owns a top-up route", async () => {
    const component = {} as Component;
    const loadStatus = vi.fn(async () => component);
    const packages = {
      crypto: {
        packageId: "@getsome/chainflip",
        load: vi.fn(async () => component),
        topUps: {
          useAdapter: vi.fn(),
          loadStatus,
        },
      },
    } satisfies FundingRoutePackages;
    const topUp = {
      id: "crypto:7",
      amount: "25",
      route: "crypto",
      startedAt: 100,
      progress,
      state: { kind: "awaiting-transfer", status: "Waiting for your transfer" },
    } satisfies FundingTopUp;

    const result = await loadFundingTopUpPackage(packages, topUp);

    expect(result).toMatchObject({
      kind: "loaded",
      topUp,
      packageId: "@getsome/chainflip",
      component,
    });
    expect(loadStatus).toHaveBeenCalledOnce();
  });

  it("never needs a package's status view for a top-up past its deposit stage", () => {
    // The shell opens finishing, failed and settled top-ups in its own journey; only one still
    // waiting for its deposit goes to the owning package.
    const base = { id: "crypto:#8", amount: "50", route: "crypto", startedAt: 100, progress };
    for (const state of [
      { kind: "finishing", status: "Converting to CASH" },
      { kind: "failed", at: 200, reason: "Channel expired" },
      { kind: "settled", at: 200, creditedAmount: "50.25" },
    ] satisfies FundingTopUp["state"][]) {
      expect(resolveFundingTopUpDestination({ ...base, state }.state)).toBe("journey");
    }
  });

  it("does not send a top-up to a package without status support", async () => {
    const component = {} as Component;
    const packages = {
      bank: { packageId: "bank-package", load: vi.fn(async () => component) },
    } satisfies FundingRoutePackages;
    const topUp = {
      id: "bank:8",
      amount: "50",
      route: "bank",
      startedAt: 200,
      progress,
      state: { kind: "finishing", status: "Received, finishing up" },
    } satisfies FundingTopUp;

    await expect(loadFundingTopUpPackage(packages, topUp)).resolves.toEqual({
      kind: "unavailable",
      topUp,
    });
  });
});

describe("availableFundingRoutes", () => {
  it("keeps only the routes with a package, in the configured order", () => {
    const packages: FundingRoutePackages = {
      crypto: { packageId: "@getsome/chainflip", load: () => Promise.resolve({} as Component) },
    };
    expect(availableFundingRoutes(packages, ["card", "bank", "crypto"])).toEqual(["crypto"]);
    expect(availableFundingRoutes({}, ["card", "bank", "crypto"])).toEqual([]);
  });

  it("this build runs card, bank and crypto", () => {
    expect(availableFundingRoutes(getcashRoutePackages, ["card", "bank", "crypto"])).toEqual([
      "card",
      "bank",
      "crypto",
    ]);
  });
});
