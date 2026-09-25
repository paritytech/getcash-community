// The constants the other packages export are re-exports from the token table. Each one is pinned
// here to the literal it held before the table existed, which is what makes the move a pure
// refactor. Core declares no dependencies, so the sibling packages are reached by path.

import { describe, expect, it } from "vitest";
import { PASEO_UNDERLYING_ASSET_ID } from "../../funding/src/paseo";
import { CASH_DECIMALS, CASH_LOCATION } from "../../people/src/cash";
import { USDC_ASSET_ID, USDT_ASSET_ID } from "../../revive/src/constants";
import { PEOPLE_NATIVE } from "../../withdraw/src/paseo";
import { CASH_ON_ASSET_HUB } from "../../withdraw/src/program";
import { TOKENS, type TokenSpec } from "./tokens";

describe("re-exported asset constants", () => {
  it("CASH on People: packages/people/src/cash.ts", () => {
    expect(CASH_DECIMALS).toBe(6);
    expect(CASH_LOCATION).toStrictEqual({
      parents: 1,
      interior: {
        type: "X3",
        value: [
          { type: "Parachain", value: 1500 },
          { type: "PalletInstance", value: 50 },
          { type: "GeneralIndex", value: 50_000_413n },
        ],
      },
    });
  });

  it("CASH on Asset Hub: packages/funding/src/paseo.ts, packages/withdraw/src/program.ts", () => {
    expect(PASEO_UNDERLYING_ASSET_ID).toBe(50_000_413);
    expect(CASH_ON_ASSET_HUB).toStrictEqual({
      parents: 0,
      interior: {
        type: "X2",
        value: [
          { type: "PalletInstance", value: 50 },
          { type: "GeneralIndex", value: 50_000_413n },
        ],
      },
    });
  });

  it("PAS on People: packages/withdraw/src/paseo.ts", () => {
    expect(PEOPLE_NATIVE).toStrictEqual({ parents: 1, interior: { type: "Here" } });
  });

  it("stables on Asset Hub: packages/revive/src/constants.ts", () => {
    expect(USDC_ASSET_ID).toBe(1337);
    expect(USDT_ASSET_ID).toBe(1984);
  });
});

describe("TOKENS", () => {
  it("keys every pallet-assets token by the same id in its Asset Hub location", () => {
    for (const token of Object.values<TokenSpec>(TOKENS)) {
      if (token.assetHubId === undefined) continue;
      expect(token.location.interior.type).toBe("X2");
      if (token.location.interior.type !== "X2") continue;
      expect(token.location.interior.value[1]).toStrictEqual({
        type: "GeneralIndex",
        value: BigInt(token.assetHubId),
      });
    }
  });
});
