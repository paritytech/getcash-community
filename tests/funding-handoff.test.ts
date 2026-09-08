// The crypto rail's handoff predicate: the deposit screen shows while this is true, and the
// moment it turns false the package hands the request to the shell's journey.

import { describe, expect, it } from "vitest";
import { chainflipDepositPending } from "../app/funding/chainflip-handoff";

describe("chainflipDepositPending", () => {
  it("waits while nothing has arrived and progress is still waiting", () => {
    expect(
      chainflipDepositPending({
        fundsSeen: false,
        phase: "awaiting-deposit",
        progressKind: "waiting",
      }),
    ).toBe(true);
  });

  it("ends the wait once a deposit has been seen, whatever progress says", () => {
    expect(
      chainflipDepositPending({
        fundsSeen: true,
        phase: "awaiting-deposit",
        progressKind: "waiting",
      }),
    ).toBe(false);
  });

  it("ends the wait when progress moves on or fails (an expired window is a handoff too)", () => {
    expect(
      chainflipDepositPending({
        fundsSeen: false,
        phase: "awaiting-deposit",
        progressKind: "active",
      }),
    ).toBe(false);
    expect(
      chainflipDepositPending({
        fundsSeen: false,
        phase: "awaiting-deposit",
        progressKind: "failed",
      }),
    ).toBe(false);
  });

  it("falls back to the phase when there is no foreground progress", () => {
    expect(
      chainflipDepositPending({ fundsSeen: false, phase: "awaiting-deposit", progressKind: null }),
    ).toBe(true);
    expect(
      chainflipDepositPending({ fundsSeen: false, phase: "swapping", progressKind: null }),
    ).toBe(false);
    expect(chainflipDepositPending({ fundsSeen: false, phase: null, progressKind: null })).toBe(
      false,
    );
  });
});
