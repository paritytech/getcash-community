import { describe, expect, it } from "vitest";
import { fundingSelectorConfig } from "../app/funding/config";
import {
  canonicalizeFundingAmount,
  createFundingSelection,
  formatFundingAmount,
  fundingAmountStatus,
  isFundingRoute,
  parseFundingAmount,
  reduceFundingAmount,
  type FundingKey,
} from "../app/funding/selection";

const rules = fundingSelectorConfig.amount;

function enter(keys: readonly FundingKey[]): string {
  return keys.reduce((amount, key) => reduceFundingAmount(amount, key, rules.decimals), "0");
}

describe("funding selection configuration", () => {
  it("defines the getcash routes and amount defaults", () => {
    expect(fundingSelectorConfig.provider).toBe("getcash.dot");
    expect(fundingSelectorConfig.amount).toMatchObject({
      decimals: 2,
      initial: "",
      minimum: "10",
      maximum: "2000",
      presets: ["10", "50", "100"],
    });
    expect(fundingSelectorConfig.routes).toMatchObject([
      { id: "card", description: "Arrive in minutes", estimate: "Instant" },
      { id: "bank", description: "1-2 business days", estimate: "1-2 days" },
      { id: "crypto", description: "Send from another wallet", estimate: "~3 min" },
    ]);
  });
});

describe("funding amount", () => {
  it("parses and formats exact decimal values", () => {
    expect(parseFundingAmount("18.75", 6)).toBe(18_750_000n);
    expect(formatFundingAmount(18_750_000n, 6)).toBe("18.75");
    expect(canonicalizeFundingAmount("002", 6)).toBeNull();
    expect(canonicalizeFundingAmount("20.000000", 6)).toBe("20");
  });

  it("rejects invalid and over-precision inputs", () => {
    for (const value of ["", ".", "-1", "1,5", "1e3", "0.0000001"]) {
      expect(parseFundingAmount(value, 6)).toBeNull();
    }
  });

  it("applies inclusive configured bounds", () => {
    expect(fundingAmountStatus("9.99", rules).kind).toBe("below-minimum");
    expect(fundingAmountStatus("10", rules).kind).toBe("valid");
    expect(fundingAmountStatus("2000", rules).kind).toBe("valid");
    expect(fundingAmountStatus("2000.01", rules).kind).toBe("above-maximum");
    // Finer than the smallest coin: not an amount the purse could hold.
    expect(fundingAmountStatus("10.001", rules).kind).toBe("invalid");
  });
});

describe("funding keypad", () => {
  it("replaces the leading zero and supports decimals", () => {
    expect(enter(["2", "0", ".", "5"])).toBe("20.5");
    expect(enter(["0", ".", "5"])).toBe("0.5");
  });

  it("limits fractional precision to the smallest coin", () => {
    expect(enter(["1", ".", "1", "2", "3", "4"])).toBe("1.12");
  });

  it("deletes back to an empty amount", () => {
    expect(reduceFundingAmount("20", "delete", 6)).toBe("2");
    expect(reduceFundingAmount("2", "delete", 6)).toBe("");
    expect(reduceFundingAmount("", "delete", 6)).toBe("");
  });

  it("starts decimal input from zero", () => {
    expect(reduceFundingAmount("", ".", 6)).toBe("0.");
  });
});

describe("funding handoff", () => {
  it("recognizes only supported route names", () => {
    expect(isFundingRoute("crypto")).toBe(true);
    expect(isFundingRoute("chainflip")).toBe(false);
  });

  it("creates a canonical immutable selection", () => {
    const selection = createFundingSelection("20.00", "crypto", rules);
    expect(selection).toEqual({ amount: "20", route: "crypto" });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(createFundingSelection("9", "bank", rules)).toBeNull();
    expect(createFundingSelection("20", null, rules)).toBeNull();
  });
});
