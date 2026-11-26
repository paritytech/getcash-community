// The kind of each refusal, read from texts that NEAR sent to dry requests.

import { describe, expect, it } from "vitest";
import { classifyRefusal, IntentsNoAnswer, IntentsRefused, type IntentsRefusal } from "./errors";

describe("classifyRefusal", () => {
  it.each<[string, string, IntentsRefusal]>([
    [
      "an exact output under the minimum, with the minimum in wei",
      "Amount is too low for bridge, try at least 110886749795838",
      { kind: "too-small", minimum: 110_886_749_795_838n },
    ],
    [
      "bitcoin under the minimum, with the minimum in satoshi",
      "Amount is too low for bridge, try at least 8300",
      { kind: "too-small", minimum: 8_300n },
    ],
    [
      "a swap under the dollar limit of a chain",
      "Temporary swap limits: minimum swap amount is $100",
      { kind: "too-small", minimumUsd: 100 },
    ],
    [
      "a dollar limit with cents",
      "Temporary swap limits: minimum swap amount is $12.5",
      { kind: "too-small", minimumUsd: 12.5 },
    ],
    ["an amount no one offers to swap", "No liquidity available", { kind: "no-liquidity" }],
    ["an asset NEAR does not know", "tokenIn is not valid", { kind: "invalid" }],
    ["an address NEAR cannot read", "recipient is not valid", { kind: "invalid" }],
    ["a deadline in the past", "deadline is not valid", { kind: "invalid" }],
    [
      "a slippage over the whole amount",
      "slippageTolerance must not be greater than 10000",
      { kind: "invalid" },
    ],
    [
      "an amount that is not in base units",
      'amount must be specified in base units (the smallest unit of your asset\'s chain). The required decimals vary by chain (e.g. 18 for ETH, 24 for NEAR, 8 for BTC). Use an integer string—e.g. "10000000000000000" for 0.01 with 18 decimals. Decimal values like "0.01" are not accepted.',
      { kind: "invalid" },
    ],
    [
      "an address with no quote behind it",
      "Deposit address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 not found",
      { kind: "not-found" },
    ],
    ["a text it does not know", "Solver capacity reached", { kind: "other" }],
    ["a text that only ends like a known one", "The route is not valid", { kind: "other" }],
    ["a text that only holds a known one", "Error: No liquidity available now", { kind: "other" }],
    ["an empty text", "", { kind: "other" }],
  ])("reads %s", (_name, message, refusal) => {
    expect(classifyRefusal(message)).toEqual(refusal);
  });

  it.each<[string, string]>([
    ["a minimum that is not a whole number", "Amount is too low for bridge, try at least 8300.5"],
    ["a minimum with no figure", "Amount is too low for bridge, try at least "],
    ["a dollar limit with no figure", "Temporary swap limits: minimum swap amount is $"],
  ])("does not make a figure from %s", (_name, message) => {
    expect(classifyRefusal(message)).toEqual({ kind: "other" });
  });
});

describe("the two errors", () => {
  it("a refusal keeps NEAR's text and its kind", () => {
    const error = new IntentsRefused("Amount is too low for bridge, try at least 8300");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IntentsRefused");
    expect(error.message).toBe("Amount is too low for bridge, try at least 8300");
    expect(error.refusal).toEqual({ kind: "too-small", minimum: 8_300n });
  });

  it("no answer keeps the reason", () => {
    const error = new IntentsNoAnswer("HTTP 503");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IntentsNoAnswer");
    expect(error.message).toBe("HTTP 503");
  });
});
