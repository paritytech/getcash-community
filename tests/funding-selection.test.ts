import { afterEach, describe, expect, it, vi } from "vitest";
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
  return keys.reduce((amount, key) => reduceFundingAmount(amount, key, rules).amount, "0");
}

describe("funding selection configuration", () => {
  it("defines the getcash routes and amount defaults", () => {
    expect(fundingSelectorConfig.provider).toBe("getcash.dot");
    expect(fundingSelectorConfig.amount).toMatchObject({
      decimals: 2,
      initial: "",
      minimum: "1",
      maximum: "5000",
      presets: ["10", "50", "100"],
    });
    expect(fundingSelectorConfig.routes).toMatchObject([
      { id: "crypto", description: "Send from another wallet", estimate: "~3 min" },
      { id: "card", description: "Arrive in minutes", estimate: "Instant" },
      { id: "bank", description: "1-2 business days", estimate: "1-2 days" },
    ]);
  });

  it("pre-selects a route the selector can actually offer", () => {
    expect(fundingSelectorConfig.defaultRoute).toBe("crypto");
    // A default naming a route that is not configured would leave the pills unpicked with no
    // sign that a default was ever meant.
    expect(fundingSelectorConfig.routes.map(({ id }) => id)).toContain(
      fundingSelectorConfig.defaultRoute,
    );
  });
});

describe("the top-up bounds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** The config as a build with these VITE_TOP_UP_MINIMUM and VITE_TOP_UP_MAXIMUM would load it. */
  async function configWith(minimum: string, maximum = "") {
    vi.stubEnv("VITE_TOP_UP_MINIMUM", minimum);
    vi.stubEnv("VITE_TOP_UP_MAXIMUM", maximum);
    vi.resetModules();
    return import("../app/funding/config");
  }

  it("is 1 CASH unless the build asks for more", async () => {
    const { fundingSelectorConfig: config } = await configWith("");
    expect(config.amount.minimum).toBe("1");
    expect(fundingAmountStatus("1", config.amount).kind).toBe("valid");
    expect(fundingAmountStatus("0.99", config.amount).kind).toBe("below-minimum");
  });

  it("takes the build's figure when it is above the floor", async () => {
    const { fundingSelectorConfig: config } = await configWith("25.5");
    expect(config.amount.minimum).toBe("25.5");
    expect(fundingAmountStatus("25.5", config.amount).kind).toBe("valid");
    expect(fundingAmountStatus("25.49", config.amount).kind).toBe("below-minimum");
    // A preset under the minimum would be a dead tap, so the three climb from the minimum instead.
    expect(config.amount.presets).toEqual(["25.5", "127.5", "255"]);
    const { fundingSelectorConfig: high } = await configWith("150");
    expect(high.amount).toMatchObject({ minimum: "150", presets: ["150", "750", "1500"] });
    // A minimum the configured presets all clear keeps them.
    const { fundingSelectorConfig: low } = await configWith("10");
    expect(low.amount.presets).toEqual(["10", "50", "100"]);
  });

  it("holds the floor against a build figure of zero, under 1 or not an amount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["0", "0.00", "-5", "ten", "1e3", "0.5"]) {
      const { fundingSelectorConfig: config } = await configWith(raw);
      expect(config.amount.minimum).toBe("1");
    }
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("raises the default maximum to a minimum set above it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fundingSelectorConfig: config } = await configWith("6000");
    // Bounds too tight for three distinct amounts leave the one there is.
    expect(config.amount).toMatchObject({ minimum: "6000", maximum: "6000", presets: ["6000"] });
    expect(fundingAmountStatus("6000", config.amount).kind).toBe("valid");
    expect(warn).not.toHaveBeenCalled();
    // A build maximum under that minimum falls back to the same figure, not to 5000.
    const { fundingSelectorConfig: under } = await configWith("6000", "5500");
    expect(under.amount).toMatchObject({ minimum: "6000", maximum: "6000" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the presets under a maximum the configured ones pass", async () => {
    // The ladder from the minimum fits under 30.
    const { fundingSelectorConfig: config } = await configWith("", "30");
    expect(config.amount.presets).toEqual(["1", "5", "10"]);
    // Under 5 it does not: the minimum, the midpoint and the maximum instead.
    const { fundingSelectorConfig: tight } = await configWith("", "5");
    expect(tight.amount.presets).toEqual(["1", "3", "5"]);
    const { fundingSelectorConfig: cents } = await configWith("", "4.5");
    expect(cents.amount.presets).toEqual(["1", "2.75", "4.5"]);
  });

  it("is 5000 CASH at most unless the build says otherwise", async () => {
    const { fundingSelectorConfig: config } = await configWith("", "");
    expect(config.amount.maximum).toBe("5000");
    const { fundingSelectorConfig: capped } = await configWith("", "250.5");
    expect(capped.amount.maximum).toBe("250.5");
    expect(fundingAmountStatus("250.5", capped.amount).kind).toBe("valid");
    expect(fundingAmountStatus("250.51", capped.amount).kind).toBe("above-maximum");
    // The keypad turns the digit away, as it does at the default.
    expect(reduceFundingAmount("250", "5", capped.amount)).toEqual({
      amount: "250",
      hitMaximum: true,
    });
  });

  it("holds the default against a build maximum of zero, not an amount, or under the minimum", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["0", "-100", "lots"]) {
      const { fundingSelectorConfig: config } = await configWith("", raw);
      expect(config.amount.maximum).toBe("5000");
    }
    // Under the floor, then under the build's own minimum: either would turn every amount away.
    const { fundingSelectorConfig: underFloor } = await configWith("", "0.5");
    expect(underFloor.amount.maximum).toBe("5000");
    const { fundingSelectorConfig: underMinimum } = await configWith("25", "20");
    expect(underMinimum.amount.maximum).toBe("5000");
    expect(warn).toHaveBeenCalledTimes(5);
    // Equal to the minimum is one valid amount, not none.
    const { fundingSelectorConfig: exact } = await configWith("25", "25");
    expect(exact.amount).toMatchObject({ minimum: "25", maximum: "25" });
    expect(fundingAmountStatus("25", exact.amount).kind).toBe("valid");
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("leaves the withdrawal bounds where they were", async () => {
    const { withdrawalSelectorConfig } = await configWith("25", "250");
    expect(withdrawalSelectorConfig.amount).toMatchObject({
      minimum: "10",
      maximum: "2000",
      presets: ["10", "50", "100"],
    });
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
    expect(fundingAmountStatus("0.99", rules).kind).toBe("below-minimum");
    expect(fundingAmountStatus("1", rules).kind).toBe("valid");
    expect(fundingAmountStatus("5000", rules).kind).toBe("valid");
    expect(fundingAmountStatus("5000.01", rules).kind).toBe("above-maximum");
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
    expect(reduceFundingAmount("20", "delete", rules).amount).toBe("2");
    expect(reduceFundingAmount("2", "delete", rules).amount).toBe("");
    expect(reduceFundingAmount("", "delete", rules).amount).toBe("");
  });

  it("starts decimal input from zero", () => {
    expect(reduceFundingAmount("", ".", rules).amount).toBe("0.");
  });

  it("turns away a digit that would pass the maximum, and reports it", () => {
    expect(reduceFundingAmount("5000", "1", rules)).toEqual({ amount: "5000", hitMaximum: true });
    expect(reduceFundingAmount("500", "0", rules)).toEqual({ amount: "5000", hitMaximum: false });
    // The bound is inclusive: cents still write up to the maximum itself, and no further.
    expect(enter(["5", "0", "0", "0", ".", "0", "0"])).toBe("5000.00");
    expect(reduceFundingAmount("5000.0", "1", rules)).toEqual({
      amount: "5000.0",
      hitMaximum: true,
    });
  });

  it("recovers from an amount written in over the maximum from outside", () => {
    // The Available pill writes the purse straight in, which can land past the maximum: digits
    // stay rejected, delete backs out.
    expect(reduceFundingAmount("6000", "1", rules)).toEqual({ amount: "6000", hitMaximum: true });
    expect(reduceFundingAmount("6000", "delete", rules).amount).toBe("600");
  });

  it("caps the whole part so a runaway entry cannot outgrow the display", () => {
    // A maximum roomier than the display cap, so only the digit-count cap can be the gate here.
    const roomy = { decimals: 2, minimum: "10", maximum: "9999999999" };
    const nineDigits = "999999999";
    expect(reduceFundingAmount(nineDigits, "9", roomy)).toEqual({
      amount: nineDigits,
      hitMaximum: false,
    });
    // The cap holds the whole part only: the fraction and a delete still edit.
    expect(reduceFundingAmount(nineDigits, ".", roomy).amount).toBe(`${nineDigits}.`);
    expect(reduceFundingAmount(`${nineDigits}.9`, "9", roomy).amount).toBe(`${nineDigits}.99`);
    expect(reduceFundingAmount(nineDigits, "delete", roomy).amount).toBe("99999999");
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
    expect(createFundingSelection("0.5", "bank", rules)).toBeNull();
    expect(createFundingSelection("20", null, rules)).toBeNull();
  });
});
