// The floor a residue must clear before a return is worth attempting: a pure gate over a real
// balance reading, nothing more.

import { describe, expect, it } from "vitest";
import { residueWorthReturning, RETURN_FLOOR_PLANCK } from "./residue";

describe("residueWorthReturning", () => {
  it("leaves a residue below the floor alone", () => {
    expect(residueWorthReturning(RETURN_FLOOR_PLANCK - 1n)).toBe(false);
    expect(residueWorthReturning(0n)).toBe(false);
  });

  it("returns a residue at or above the floor", () => {
    expect(residueWorthReturning(RETURN_FLOOR_PLANCK)).toBe(true);
    expect(residueWorthReturning(RETURN_FLOOR_PLANCK + 1n)).toBe(true);
    expect(residueWorthReturning(10n * RETURN_FLOOR_PLANCK)).toBe(true);
  });

  it("is conservative: comfortably above the funding program's own sizing guess, not equal to it", () => {
    // The floor exists so a return does not spend most of what it recovers; it must sit well
    // clear of the raw fee guess it is built from, not merely above it.
    const FUNDING_PROGRAM_FEE_GUESS_PLANCK = 200_000_000n;
    expect(RETURN_FLOOR_PLANCK).toBeGreaterThanOrEqual(FUNDING_PROGRAM_FEE_GUESS_PLANCK * 3n);
  });
});
