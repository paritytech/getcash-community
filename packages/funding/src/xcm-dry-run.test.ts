// What a dry run credited to an account, read off its events: the native's deposits, a token's,
// and one token's alone when its id is named.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { creditedTo } from "./xcm-dry-run";

const WHO = AccountId(0).dec(new Uint8Array(32).fill(0xaa));
const WHO_HEX = `0x${"aa".repeat(32)}`;
const OTHER = AccountId(0).dec(new Uint8Array(32).fill(0xbb));

const deposited = (assetId: number, amount: bigint, who = WHO) => ({
  type: "Assets",
  value: { type: "Deposited", value: { asset_id: assetId, who, amount } },
});
const deposit = (amount: bigint, who = WHO) => ({
  type: "Balances",
  value: { type: "Deposit", value: { who, amount } },
});

describe("creditedTo", () => {
  it("sums the account's deposits of the named token alone, of every token when none is named, and of the native apart", () => {
    const events = [
      deposited(1337, 5n),
      deposited(50_000_413, 7n),
      deposited(1337, 100n, OTHER),
      deposit(9n),
      deposit(100n, OTHER),
    ];
    expect(creditedTo(events, WHO_HEX, "asset", 1337)).toBe(5n);
    expect(creditedTo(events, WHO_HEX, "asset", 1984)).toBe(0n);
    expect(creditedTo(events, WHO_HEX, "asset")).toBe(12n);
    expect(creditedTo(events, WHO_HEX, "native")).toBe(9n);
  });
});
