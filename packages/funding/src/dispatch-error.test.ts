import { describe, expect, it } from "vitest";
import { psmRefusalKind } from "./dispatch-error";

const psmError = (variant: string) => ({
  type: "Module",
  value: { type: "Psm", value: { type: variant } },
});

describe("psmRefusalKind", () => {
  it("tells a pair short of room apart from a paused one and from a swap it will not serve", () => {
    expect(psmRefusalKind(psmError("InsufficientReserve"))).toBe("capacity");
    expect(psmRefusalKind(psmError("AllSwapsStopped"))).toBe("unavailable");
    expect(psmRefusalKind(psmError("FeeTooHigh"))).toBe("will-not-serve");
    expect(psmRefusalKind(psmError("PsmNotFound"))).toBeNull();
    expect(
      psmRefusalKind({ type: "Module", value: { type: "Assets", value: { type: "BalanceLow" } } }),
    ).toBeNull();
  });
});
