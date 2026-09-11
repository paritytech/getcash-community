import { describe, expect, it } from "vitest";
import {
  resolveFundingShellScreen,
  resolveFundingTopUpDestination,
} from "../app/funding/navigation";

describe("funding shell entry navigation", () => {
  it("opens pending when it has active or recently settled content", () => {
    expect(resolveFundingShellScreen("pending", true)).toBe("pending");
    expect(resolveFundingShellScreen("pending", false)).toBe("amount");
  });

  it("restores explicit amount and history destinations", () => {
    expect(resolveFundingShellScreen("amount", true)).toBe("amount");
    expect(resolveFundingShellScreen("history", false)).toBe("history");
  });

  it("lands automatic entry on the amount screen when nothing is running", () => {
    expect(resolveFundingShellScreen("auto", false)).toBe("amount");
    // Recently settled content alone is not a running top-up.
    expect(resolveFundingShellScreen("auto", true)).toBe("amount");
  });

  it("lands automatic entry on the pending screen while a top-up is in progress", () => {
    expect(resolveFundingShellScreen("auto", true, true)).toBe("pending");
  });
});

describe("opening a top-up from the list", () => {
  it("sends one still waiting for its deposit to the owning package's screen", () => {
    expect(
      resolveFundingTopUpDestination({
        kind: "awaiting-transfer",
        status: "Waiting for your transfer",
      }),
    ).toBe("package");
  });

  it("opens everything past the deposit stage straight into the shell's journey", () => {
    expect(
      resolveFundingTopUpDestination({ kind: "finishing", status: "Converting to CASH" }),
    ).toBe("journey");
    expect(
      resolveFundingTopUpDestination({ kind: "failed", at: 1, reason: "Channel expired" }),
    ).toBe("journey");
    expect(resolveFundingTopUpDestination({ kind: "settled", at: 1 })).toBe("journey");
  });
});
