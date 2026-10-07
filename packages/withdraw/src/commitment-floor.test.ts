// A sale that promised its provider an exact figure is held to it before anything is signed: a
// floor below what the payment needs is refused, and nothing on People is asked.

import { describe, expect, it } from "vitest";
import { CommitmentUnfundableError, sizeXcm, type SizeXcmInput } from "./fees";

const QUOTED = 25_000_000_000n;

/** An Asset Hub that quotes the sale and cannot read its pool, so the caller's ceiling ships. */
const assetHubApi = {
  apis: {
    AssetConversionApi: { quote_price_exact_tokens_for_tokens: async () => QUOTED },
  },
  view: {},
  constants: { AssetConversion: { LPFee: async () => 3_000 } },
} as unknown as SizeXcmInput["assetHubApi"];

/** A People that must not be reached: the refusal comes before any of it. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error("People was asked");
    },
  },
) as unknown as SizeXcmInput["peopleApi"];

const input = (minLanding?: bigint): SizeXcmInput => ({
  peopleApi: untouchable,
  assetHubApi,
  key: { address: "5Key", publicKeyHex: `0x${"11".repeat(32)}` },
  cashOnKey: 100_000_000n,
  pasOnKey: 50_000_000_000n,
  destinationHex: `0x${"11".repeat(32)}`,
  assetHubParaId: 1500,
  peopleParaId: 1004,
  sale: { tier: "pool" },
  slippagePct: 5,
  transfer: "teleport",
  ...(minLanding === undefined ? {} : { minLanding }),
});

describe("the sale's floor against a promised payment", () => {
  it("refuses a floor below what the payment needs, before People is asked", async () => {
    // The ceiling ships as the floor: 5% under the quote.
    const floor = (QUOTED * 95n) / 100n;
    const error = await sizeXcm(input(floor + 1n)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommitmentUnfundableError);
    expect(error).toMatchObject({ floor, needed: floor + 1n });
  });

  it("goes on to size the XCM when the floor covers the payment", async () => {
    const floor = (QUOTED * 95n) / 100n;
    await expect(sizeXcm(input(floor))).rejects.toThrow(/People was asked/);
    await expect(sizeXcm(input())).rejects.toThrow(/People was asked/);
  });
});
