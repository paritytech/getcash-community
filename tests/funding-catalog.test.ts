// The on-ramp catalog: the direct Polkadot network alone, and its source id map agreeing both
// ways.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIRECT_SOURCE_IDS,
  depositAssetFor,
  FUNDING_CHAINS,
  isDirectSourceId,
  POLKADOT_CHAIN,
  sourceIdFor,
  sourcePairFor,
} from "~~/lib/config";
import { isCryptoSourceId } from "~~/app/funding/source-ids";
import { networkIcon, tokenIcon } from "~~/app/utils/icons";
import { railProviderOf, routeOf } from "~~/app/funding/requests/model";

describe("the funding catalog", () => {
  it("lists Polkadot alone, with DOT, dotUSD, USDT and USDC", () => {
    expect(FUNDING_CHAINS).toEqual([POLKADOT_CHAIN]);
    expect(POLKADOT_CHAIN).toMatchObject({
      chain: "Polkadot",
      native: "DOT",
      assets: ["DOT", "dotUSD", "USDT", "USDC"],
      label: "Polkadot",
    });
  });

  it("has an icon file of its own for every network and token", () => {
    const icons = FUNDING_CHAINS.flatMap((chain) => [
      networkIcon(chain.chain),
      ...chain.assets.map(tokenIcon),
    ]);
    expect(icons).not.toContain("/icons/add-money.svg");
    for (const icon of new Set(icons)) {
      const file = fileURLToPath(new URL(`../public${icon}`, import.meta.url));
      expect(existsSync(file), icon).toBe(true);
    }
  });

  it("maps a pair to its source, and back", () => {
    expect(sourceIdFor("Polkadot", "DOT")).toBe("dot-assethub");
    expect(sourceIdFor("Polkadot", "dotUSD")).toBe("dotusd-assethub");
    expect(sourceIdFor("Polkadot", "USDT")).toBe("usdt-assethub");
    expect(sourceIdFor("Polkadot", "USDC")).toBe("usdc-assethub");
    expect(sourceIdFor("Ethereum", "USDC")).toBeUndefined();
    expect(sourceIdFor("Polkadot", "BTC")).toBeUndefined();
    expect(sourcePairFor("usdc-assethub")).toEqual({ chain: "Polkadot", asset: "USDC" });
    expect(sourcePairFor("dotusd-assethub")).toEqual({ chain: "Polkadot", asset: "dotUSD" });
    expect(sourcePairFor("dot-assethub")).toEqual({ chain: "Polkadot", asset: "DOT" });
    expect(sourcePairFor("usdt-tron")).toBeUndefined();
    expect(sourcePairFor("meld-card")).toBeUndefined();
  });

  it("names what each direct source deposits, and which ids are direct", () => {
    expect(DIRECT_SOURCE_IDS).toEqual([
      "dot-assethub",
      "dotusd-assethub",
      "usdt-assethub",
      "usdc-assethub",
    ]);
    expect(depositAssetFor("dot-assethub")).toBe("native");
    expect(depositAssetFor("dotusd-assethub")).toBe("dotUSD");
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
    expect(isCryptoSourceId("meld-card")).toBe(false);
    expect(isCryptoSourceId("nope")).toBe(false);
    for (const sourceId of DIRECT_SOURCE_IDS) {
      expect(railProviderOf(sourceId)).toBe("manual");
      expect(routeOf(sourceId)).toBe("crypto");
    }
    expect(railProviderOf("meld-card")).toBe("meld");
  });
});
