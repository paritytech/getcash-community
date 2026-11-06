import { describe, expect, it } from "vitest";
import { withdrawalSelectorConfig } from "../app/funding/config";
import { readWithdrawHandoff, withdrawHandoffParams } from "../app/withdraw/handoff";

const decimals = withdrawalSelectorConfig.amount.decimals;
const read = (search: string) => readWithdrawHandoff(new URLSearchParams(search), decimals);

describe("the withdrawal hand-off", () => {
  it("reads an amount and a route", () => {
    expect(read("amount=120.5&route=bank")).toEqual({ amount: "120.5", route: "bank" });
    expect(read("?amount=10.00&route=crypto")).toEqual({ amount: "10", route: "crypto" });
  });

  it("takes either one alone", () => {
    expect(read("amount=42")).toEqual({ amount: "42", route: null });
    expect(read("route=card")).toEqual({ amount: null, route: "card" });
  });

  it("drops an amount it cannot carry exactly instead of rounding it", () => {
    expect(read("amount=1.234&route=bank")).toEqual({ amount: null, route: "bank" });
    expect(read("amount=-5&route=bank")).toEqual({ amount: null, route: "bank" });
    expect(read("amount=1e3&route=bank")).toEqual({ amount: null, route: "bank" });
    expect(read("amount=0&route=bank")).toEqual({ amount: null, route: "bank" });
  });

  it("leaves the amount's bounds to the amount screen", () => {
    expect(read("amount=1")).toEqual({ amount: "1", route: null });
    expect(read("amount=999999")).toEqual({ amount: "999999", route: null });
  });

  it("is no hand-off without a readable amount or route", () => {
    expect(read("")).toBeNull();
    expect(read("route=paypal")).toBeNull();
    expect(read("amount=abc&route=")).toBeNull();
  });

  it("lets the hash route's query speak over the page's search", () => {
    const params = withdrawHandoffParams("?amount=5&route=bank", { amount: "25", other: "x" });
    expect(readWithdrawHandoff(params, decimals)).toEqual({ amount: "25", route: "bank" });
  });
});
