import { describe, expect, it } from "vitest";
import { withdrawalSelectorConfig } from "../app/funding/config";
import { cashToAmountInput } from "../app/utils/cash";
import { assessWithdrawalAmount } from "../app/withdraw/amount";

const rules = withdrawalSelectorConfig.amount;
// The purse the withdrawal frames are drawn against.
const purse = "226.78";

const assess = (amount: string, available: string | null | undefined = purse) =>
  assessWithdrawalAmount(amount, withdrawalSelectorConfig, available);

describe("the line under the withdrawal amount", () => {
  it("offers the minimum as a hint before anything is entered", () => {
    expect(assess("")).toEqual({ text: "Minimum $10 CASH", breach: false, withdrawable: false });
    expect(assess("0")).toEqual({ text: "Minimum $10 CASH", breach: false, withdrawable: false });
  });

  it("names the minimum as a breach once an amount under it is entered", () => {
    expect(assess("1")).toEqual({ text: "Minimum $10 CASH", breach: true, withdrawable: false });
    expect(assess("9.99")).toEqual({ text: "Minimum $10 CASH", breach: true, withdrawable: false });
  });

  it("names the maximum, grouped, above it", () => {
    expect(assess("3000")).toEqual({
      text: "Maximum $2,000 CASH",
      breach: true,
      withdrawable: false,
    });
  });

  it("names the purse for an amount inside the bounds it cannot pay", () => {
    expect(assess("400")).toEqual({ text: "Not enough CASH", breach: true, withdrawable: false });
  });

  it("reports the maximum before the purse, as the frames pair them", () => {
    // $3,000 against a 226.78 purse breaks both; the design answers with the maximum.
    expect(assess("3000").text).toBe("Maximum $2,000 CASH");
  });

  it("returns the standing minimum line for an amount that breaks nothing", () => {
    expect(assess("24")).toEqual({
      text: "Withdrawal minimum $10 CASH",
      breach: false,
      withdrawable: true,
    });
    expect(assess(purse).withdrawable).toBe(true);
  });
});

describe("the amount a withdrawal can open on", () => {
  it("takes an amount inside the bounds and inside the purse", () => {
    expect(assess("24").withdrawable).toBe(true);
    expect(assess(purse).withdrawable).toBe(true);
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
      text: "Withdrawal minimum $10 CASH",
      breach: false,
      withdrawable: false,
    });
    // A purse string the parser cannot read back is unknown too, not unbounded.
    expect(assess("24", "1,000").withdrawable).toBe(false);
    // Undefined: there is no purse (outside a host) — only the configured bounds apply.
    expect(assess("24", undefined)).toEqual({
      text: "Withdrawal minimum $10 CASH",
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
      text: "Minimum $2,000 CASH",
      breach: false,
      withdrawable: false,
    });
    const unreadable = { ...withdrawalSelectorConfig, amount: { ...rules, minimum: "ten" } };
    expect(assessWithdrawalAmount("24", unreadable, purse).withdrawable).toBe(false);
  });
});

// The page hands the screen its purse through cashToAmountInput, so the comparison is only as good
// as that seam: the converted string must be one parseFundingAmount can read back. A drift here
// (grouping, extra decimals) now fails closed rather than silently lifting the cap.
describe("the purse as the page actually delivers it", () => {
  // 6-dec base units, as usePurseBalance reads them from the host.
  const deliver = (base: bigint) => cashToAmountInput(base, rules.decimals);

  it("compares the typed amount against the converted balance", () => {
    const available = deliver(226_780_000n); // 226.78 CASH
    expect(available).toBe("226.78");
    expect(assess("226.78", available).withdrawable).toBe(true);
    expect(assess("226.79", available)).toEqual({
      text: "Not enough CASH",
      breach: true,
      withdrawable: false,
    });
  });

  it("rounds sub-cent dust down, never lending the pill more than the purse", () => {
    const available = deliver(226_789_999n); // 226.789999 CASH
    expect(available).toBe("226.78");
    expect(assess("226.79", available).breach).toBe(true);
  });

  it("reads a whole and an empty purse back", () => {
    expect(deliver(2_000_000_000n)).toBe("2000");
    expect(assess("2000", deliver(2_000_000_000n)).withdrawable).toBe(true);
    expect(assess("10", deliver(0n))).toEqual({
      text: "Not enough CASH",
      breach: true,
      withdrawable: false,
    });
  });
});
