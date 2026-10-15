import { describe, expect, it } from "vitest";
import { withdrawalSelectorConfig } from "../app/funding/config";
import { assessWithdrawalAmount } from "../app/withdraw/amount";

const rules = withdrawalSelectorConfig.amount;
// The purse the withdrawal frames are drawn against: 226.78 CASH, in 6-dec base units as
// usePurseBalance reads them from the host.
const purse = 226_780_000n;

const assess = (amount: string, available: bigint | null | undefined = purse) =>
  assessWithdrawalAmount(amount, withdrawalSelectorConfig, available);

describe("the line under the withdrawal amount", () => {
  it("offers the minimum as a hint before anything is entered", () => {
    expect(assess("")).toEqual({
      lead: "Minimum ",
      amount: "10",
      breach: false,
      withdrawable: false,
    });
    expect(assess("0")).toEqual({
      lead: "Minimum ",
      amount: "10",
      breach: false,
      withdrawable: false,
    });
  });

  it("names the minimum as a breach once an amount under it is entered", () => {
    expect(assess("1")).toEqual({
      lead: "Minimum ",
      amount: "10",
      breach: true,
      withdrawable: false,
    });
    expect(assess("9.99")).toEqual({
      lead: "Minimum ",
      amount: "10",
      breach: true,
      withdrawable: false,
    });
  });

  it("names the maximum, grouped, above it", () => {
    expect(assess("3000")).toEqual({
      lead: "Maximum ",
      amount: "2,000",
      breach: true,
      withdrawable: false,
    });
  });

  it("names the purse for an amount inside the bounds it cannot pay", () => {
    expect(assess("400")).toEqual({
      lead: "Not enough CASH",
      amount: null,
      breach: true,
      withdrawable: false,
    });
  });

  it("reports the maximum before the purse, as the frames pair them", () => {
    // $3,000 against a 226.78 purse breaks both; the design answers with the maximum.
    expect(assess("3000").lead).toBe("Maximum ");
  });

  it("carries no line for an amount that breaks nothing", () => {
    expect(assess("24")).toEqual({ lead: "", amount: null, breach: false, withdrawable: true });
    expect(assess("226.78").withdrawable).toBe(true);
  });
});

describe("the amount a withdrawal can open on", () => {
  it("takes an amount inside the bounds and inside the purse", () => {
    expect(assess("24").withdrawable).toBe(true);
    expect(assess("226.78").withdrawable).toBe(true);
  });

  it("refuses an empty amount, a broken bound and an amount over the purse", () => {
    expect(assess("").withdrawable).toBe(false);
    expect(assess("0").withdrawable).toBe(false);
    expect(assess("1").withdrawable).toBe(false);
    expect(assess("3000").withdrawable).toBe(false);
    expect(assess("400").withdrawable).toBe(false);
  });

  it("fails closed while the purse is unknown, open only where there is provably none", () => {
    // Null: the balance read is still in flight — no bound to name, nothing may open.
    expect(assess("24", null)).toEqual({
      lead: "",
      amount: null,
      breach: false,
      withdrawable: false,
    });
    // Undefined: there is no purse (outside a host) — only the configured bounds apply.
    expect(assess("24", undefined)).toEqual({
      lead: "",
      amount: null,
      breach: false,
      withdrawable: true,
    });
  });

  it("refuses to open on rules it cannot read, keeping the hint", () => {
    // A misconfiguration: the top-up screen disables its CTA in the same state, so this one does
    // too rather than offering a click the shell would silently drop.
    const inverted = {
      ...withdrawalSelectorConfig,
      amount: { ...rules, minimum: "2000", maximum: "10" },
    };
    expect(assessWithdrawalAmount("24", inverted, purse)).toEqual({
      lead: "Minimum ",
      amount: "2,000",
      breach: false,
      withdrawable: false,
    });
    const unreadable = { ...withdrawalSelectorConfig, amount: { ...rules, minimum: "ten" } };
    expect(assessWithdrawalAmount("24", unreadable, purse).withdrawable).toBe(false);
  });
});

// The purse arrives in base units and is truncated down to the keypad's scale inside the
// assessment, so the gate can never be lent sub-cent dust the pill does not offer.
describe("the purse as the host actually reports it", () => {
  it("compares the typed amount against the truncated balance", () => {
    expect(assess("226.78", 226_780_000n).withdrawable).toBe(true);
    expect(assess("226.79", 226_780_000n)).toEqual({
      lead: "Not enough CASH",
      amount: null,
      breach: true,
      withdrawable: false,
    });
  });

  it("rounds sub-cent dust down, never lending the gate more than the pill offers", () => {
    // 226.789999 CASH: the pill writes 226.78, so 226.79 must not open.
    expect(assess("226.79", 226_789_999n).breach).toBe(true);
    expect(assess("226.78", 226_789_999n).withdrawable).toBe(true);
  });

  it("reads a whole and an empty purse back", () => {
    expect(assess("2000", 2_000_000_000n).withdrawable).toBe(true);
    expect(assess("10", 0n)).toEqual({
      lead: "Not enough CASH",
      amount: null,
      breach: true,
      withdrawable: false,
    });
  });
});
