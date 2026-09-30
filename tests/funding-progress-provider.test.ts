import { describe, expect, it } from "vitest";
import {
  chainflipProgressProvider,
  DIRECT_DEPOSIT_STAGE,
  directProgressProvider,
  meldProgressProvider,
  observeDirectProgress,
  progressProviderForSource,
} from "../app/funding/progress";

describe("progressProviderForSource", () => {
  it("projects fiat sources through the Meld provider, direct sources through the direct one, and swap sources through Chainflip's", () => {
    expect(progressProviderForSource("meld-card")).toBe(meldProgressProvider);
    expect(progressProviderForSource("meld-bank")).toBe(meldProgressProvider);
    expect(progressProviderForSource("dot-assethub")).toBe(directProgressProvider);
    expect(progressProviderForSource("usdt-assethub")).toBe(directProgressProvider);
    expect(progressProviderForSource("usdc-assethub")).toBe(directProgressProvider);
    // A record with no source id belongs to the crypto rail's direct deposit.
    expect(progressProviderForSource(undefined)).toBe(directProgressProvider);
    expect(progressProviderForSource("btc")).toBe(chainflipProgressProvider);
  });
});

describe("the direct deposit's progress", () => {
  it("is one confirming stage ahead of the shared CASH stages, with the manual rail's words", () => {
    const profile = directProgressProvider.createProfile();
    expect(profile.id).toBe("direct");
    expect(profile.stages.map(({ key }) => key)).toEqual([
      DIRECT_DEPOSIT_STAGE,
      "cash-conversion",
      "cash-top-up",
    ]);
    expect(profile.routeStageCount).toBe(1);
    expect(profile.routeCompletedLabel).toBe("Payment received");
    expect(observeDirectProgress("waiting")).toEqual({ kind: "waiting" });
    expect(observeDirectProgress("complete")).toEqual({ kind: "route-complete" });
    // The manual rail never reports a stage of its own; the burner sighting completes it.
    expect(observeDirectProgress("receiving")).toEqual({ kind: "hold" });
    expect(observeDirectProgress("swapping")).toEqual({ kind: "hold" });
  });
});
