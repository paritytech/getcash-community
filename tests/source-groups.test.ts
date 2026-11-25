// The pickers' wording for a minimum.

import { describe, expect, it } from "vitest";
import { wholeCashCeil } from "../app/funding/source-groups";

describe("source groups", () => {
  it("rounds a minimum up to whole CASH", () => {
    expect(wholeCashCeil(80_000_000n)).toBe("80");
    expect(wholeCashCeil(80_000_001n)).toBe("81");
  });
});
