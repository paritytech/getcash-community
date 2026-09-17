import { describe, expect, it } from "vitest";
import {
  resolveFundingShellScreen,
  resolveFundingTopUpDestination,
} from "../app/funding/navigation";

describe("funding shell entry navigation", () => {
  it("opens the top-ups screen only while a top-up is in progress", () => {
    expect(resolveFundingShellScreen("pending", true)).toBe("pending");
    expect(resolveFundingShellScreen("auto", true)).toBe("pending");
  });

  it("sends a buyer whose top-ups have all settled to the amount screen", () => {
    // Nothing is running, so there is no "Top-up in progress" to title: the receipt is history,
    // and the amount screen's clock is how the buyer reaches it. This is the case a journey
    // closing back to the list ("pending") lands in once the last top-up has landed.
    expect(resolveFundingShellScreen("pending", false)).toBe("amount");
    expect(resolveFundingShellScreen("auto", false)).toBe("amount");
  });

  it("restores explicit amount and history destinations", () => {
    expect(resolveFundingShellScreen("amount", true)).toBe("amount");
    expect(resolveFundingShellScreen("history", false)).toBe("history");
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
