// The words the deposit mismatch sheet shows: one title and sentence per kind, the CASH sum on the
// accept pill in the app's own form. The figures are drawn by the sheet, so the sentences leave
// them out.

import { describe, expect, it } from "vitest";
import { describeMismatch } from "../app/funding/deposit-mismatch";

const asked = { amount: "10", symbol: "USDC" };

describe("describeMismatch", () => {
  it("words a short deposit around what arrived", () => {
    const text = describeMismatch({
      kind: "short",
      asked,
      landed: { amount: "8", symbol: "USDC" },
      target: "10",
      receive: "7.94",
    });
    expect(text.title).toBe("Less arrived than asked");
    expect(text.body).toBe("We can convert what arrived instead, or you can take it back.");
    expect(text.accept).toBe("Continue with $7.94 CASH");
  });

  it("names both tokens when a different one arrived", () => {
    const text = describeMismatch({
      kind: "token",
      asked,
      landed: { amount: "10", symbol: "USDT" },
      target: "10",
      receive: "9.85",
    });
    expect(text.title).toBe("USDT arrived instead of USDC");
    expect(text.body).toBe("We can convert USDT too, at its own rate, or you can take it back.");
    expect(text.accept).toBe("Continue with $9.85 CASH");
  });
});
