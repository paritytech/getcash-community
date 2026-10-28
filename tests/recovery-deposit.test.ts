import { describe, expect, it } from "vitest";
import { recoveryChoices } from "../app/funding/recovery-deposit";

const recovery = (minimums: Record<string, string | null>) => ({
  trappedAmount: "25000000",
  trappedAt: 0,
  claimerHex: `0x${"07".repeat(32)}`,
  round: 0,
  minimums,
});

describe("recoveryChoices", () => {
  it("lists the priced tokens in the design's order, named as the deposit screen names them", () => {
    const choices = recoveryChoices(
      recovery({ USDT: "650000", PAS: "900000000", USDC: "650000", DOTUSD: "600000" }),
    );
    expect(choices.map((c) => [c.token, c.name, c.amount])).toEqual([
      ["PAS", "DOT", "0.09"],
      ["DOTUSD", "dotUSD", "0.6"],
      ["USDC", "USDC", "0.65"],
      ["USDT", "USDT", "0.65"],
    ]);
  });

  it("rounds the least to send up to four places, never down", () => {
    const [usdt] = recoveryChoices(recovery({ USDT: "650001" }));
    expect(usdt?.amount).toBe("0.6501");
    const [pas] = recoveryChoices(recovery({ PAS: "1" }));
    expect(pas?.amount).toBe("0.0001");
  });

  it("leaves out a token the chain could not price, and lists none before the worker priced", () => {
    expect(recoveryChoices(recovery({ PAS: null, USDT: null })).map((c) => c.token)).toEqual([]);
    expect(recoveryChoices(recovery({ PAS: null, USDT: "650000" })).map((c) => c.token)).toEqual([
      "USDT",
    ]);
    expect(recoveryChoices(undefined)).toEqual([]);
  });
});
