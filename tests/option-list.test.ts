// The order every picker lists its rows in.

import { describe, expect, it } from "vitest";
import { sortPickable } from "../app/utils/option-list";

describe("option list", () => {
  it("lists pickable rows first, keeping each group's order", () => {
    const eth = { key: "Ethereum", pickable: true };
    const btc = { key: "Bitcoin", pickable: false };
    const sol = { key: "Solana", pickable: true };
    const trx = { key: "Tron", pickable: false };
    expect(sortPickable([btc, eth, trx, sol])).toEqual([eth, sol, btc, trx]);
    expect(sortPickable([btc])).toEqual([btc]);
    expect(sortPickable([])).toEqual([]);
  });
});
