// The on-ramp catalog: the direct Polkadot network in front of the Chainflip ones, the Chainflip
// catalog unchanged for the withdraw side and the floors, and the two source id maps agreeing.

import { describe, expect, it } from "vitest";
import {
  DIRECT_SOURCE_IDS,
  depositAssetFor,
  FUNDING_CHAINS,
  isDirectSourceId,
  POLKADOT_CHAIN,
  SOURCE_CHAINS,
  sourceIdFor,
  sourcePairFor,
} from "~~/lib/config";
import { isCryptoSourceId } from "~~/app/funding/source-ids";
import { railProviderOf, routeOf } from "~~/app/funding/requests/model";

describe("the funding catalog", () => {
  it("lists Polkadot first with DOT, USDT and USDC, then the Chainflip networks", () => {
    expect(FUNDING_CHAINS[0]).toBe(POLKADOT_CHAIN);
    expect(POLKADOT_CHAIN).toMatchObject({
      chain: "Polkadot",
      native: "DOT",
      assets: ["DOT", "USDT", "USDC"],
      label: "Polkadot",
    });
    expect(FUNDING_CHAINS.slice(1)).toEqual(SOURCE_CHAINS);
  });

  it("keeps the Chainflip catalog as it was, which the withdraw side and the floors read", () => {
    expect(SOURCE_CHAINS.map((chain) => chain.chain)).toEqual([
      "Bitcoin",
      "Ethereum",
      "Solana",
      "Tron",
    ]);
    expect(SOURCE_CHAINS.some((chain) => (chain.chain as string) === "Polkadot")).toBe(false);
  });

  it("maps a pair to its source in either catalog, and back", () => {
    expect(sourceIdFor("Polkadot", "DOT")).toBe("dot-assethub");
    expect(sourceIdFor("Polkadot", "USDT")).toBe("usdt-assethub");
    expect(sourceIdFor("Polkadot", "USDC")).toBe("usdc-assethub");
    expect(sourceIdFor("Ethereum", "USDC")).toBe("usdc-eth");
    expect(sourceIdFor("Polkadot", "BTC")).toBeUndefined();
    expect(sourcePairFor("usdc-assethub")).toEqual({ chain: "Polkadot", asset: "USDC" });
    expect(sourcePairFor("dot-assethub")).toEqual({ chain: "Polkadot", asset: "DOT" });
    expect(sourcePairFor("usdt-tron")).toEqual({ chain: "Tron", asset: "USDT" });
    expect(sourcePairFor("meld-card")).toBeUndefined();
  });

  it("names what each direct source deposits, and which ids are direct", () => {
    expect(DIRECT_SOURCE_IDS).toEqual(["dot-assethub", "usdt-assethub", "usdc-assethub"]);
    expect(depositAssetFor("dot-assethub")).toBe("native");
    expect(depositAssetFor("usdt-assethub")).toBe("USDT");
    expect(depositAssetFor("usdc-assethub")).toBe("USDC");
    expect(isDirectSourceId("usdc-assethub")).toBe(true);
    expect(isDirectSourceId("usdc-eth")).toBe(false);
    expect(isDirectSourceId(undefined)).toBe(false);
  });

  it("runs every direct source on the crypto route over the manual rail", () => {
    expect(isCryptoSourceId(undefined)).toBe(true);
    expect(isCryptoSourceId("usdt-assethub")).toBe(true);
    expect(isCryptoSourceId("btc")).toBe(false);
    for (const sourceId of DIRECT_SOURCE_IDS) {
      expect(railProviderOf(sourceId)).toBe("manual");
      expect(routeOf(sourceId)).toBe("crypto");
    }
    expect(railProviderOf("btc")).toBe("chainflip");
    expect(railProviderOf("meld-card")).toBe("meld");
  });
});
