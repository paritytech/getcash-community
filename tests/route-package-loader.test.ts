import { describe, expect, it, vi } from "vitest";
import type { Component } from "vue";
import { useRoutePackageLoader } from "../app/composables/useRoutePackageLoader";
import type { FundingRoutePackages } from "../app/funding/packages";

// vitest has no Vue plugin, and this test never renders the screens the registry module bundles.
vi.mock("../app/components/funding/routes/MeldFundingStatusRoute.vue", () => ({ default: {} }));
vi.mock("../app/components/funding/routes/ChainflipFundingStatusRoute.vue", () => ({
  default: {},
}));

const label = (route: string) => route.toUpperCase();

/** A registry whose crypto package resolves when `release` is called. */
function gatedPackages() {
  let release: (component: Component) => void = () => {};
  const packages = {
    crypto: {
      packageId: "gated",
      load: () => new Promise<Component>((resolve) => (release = resolve)),
    },
  } satisfies FundingRoutePackages;
  return { packages, release: (component: Component) => release(component) };
}

describe("useRoutePackageLoader", () => {
  it("loads the selected route's package and keeps the selection", async () => {
    const component = { name: "Crypto" };
    const loader = useRoutePackageLoader(
      { crypto: { packageId: "p", load: async () => component } },
      label,
    );
    await loader.continueToPackage({ amount: "25", route: "crypto" });
    expect(loader.activePackage.value).toBe(component);
    expect(loader.selection.value).toEqual({ amount: "25", route: "crypto" });
    expect(loader.loading.value).toBe(false);
    expect(loader.routeError.value).toBeNull();
  });

  it("names an unavailable route and a failed load in the shell's words", async () => {
    const loader = useRoutePackageLoader(
      {
        crypto: {
          packageId: "broken",
          load: async () => {
            throw new Error("boom");
          },
        },
      },
      label,
    );
    await loader.continueToPackage({ amount: "25", route: "card" });
    expect(loader.routeError.value).toBe("CARD isn't available in this build yet.");
    expect(loader.activePackage.value).toBeNull();
    await loader.continueToPackage({ amount: "25", route: "crypto" });
    expect(loader.routeError.value).toBe("CRYPTO couldn't be opened. Try again.");
  });

  it("drops a load the shell cancelled or superseded, and unmounts on return", async () => {
    const { packages, release } = gatedPackages();
    const loader = useRoutePackageLoader(packages, label);
    const first = loader.continueToPackage({ amount: "25", route: "crypto" });
    expect(loader.loading.value).toBe(true);
    loader.cancelPendingLoad();
    expect(loader.loading.value).toBe(false);
    release({ name: "late" });
    await first;
    // The late answer never became the active package.
    expect(loader.activePackage.value).toBeNull();

    const second = loader.continueToPackage({ amount: "30", route: "crypto" });
    release({ name: "second" });
    await second;
    expect(loader.activePackage.value).toEqual({ name: "second" });
    loader.returnToShell();
    expect(loader.activePackage.value).toBeNull();
    expect(loader.selection.value).toEqual({ amount: "30", route: "crypto" });
  });

  it("switches route keeping the amount", async () => {
    const seen: string[] = [];
    const loader = useRoutePackageLoader(
      {
        crypto: { packageId: "c", load: async () => ({ name: "c" }) },
        card: { packageId: "k", load: async () => ({ name: "k" }) },
      },
      label,
    );
    await loader.continueToPackage({ amount: "40", route: "crypto" });
    loader.switchRoute("card");
    await new Promise((resolve) => setTimeout(resolve, 0));
    seen.push(loader.selection.value?.route ?? "");
    expect(seen).toEqual(["card"]);
    expect(loader.selection.value?.amount).toBe("40");
    expect(loader.activePackage.value).toEqual({ name: "k" });
  });
});
