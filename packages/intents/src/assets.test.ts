// The asset table, and how each source reaches the key for each route.

import type { SourceId } from "@getsome/core";
import { describe, expect, it } from "vitest";
import { INTENTS_ETH, INTENTS_SOURCES, sourceReach, type SourceReach } from "./assets";

const entries = Object.entries(INTENTS_SOURCES) as [SourceId, { asset: string }][];

describe("INTENTS_SOURCES", () => {
  it("names each asset once, in NEAR's form", () => {
    const assets = entries.map(([, source]) => source.asset);
    expect(new Set(assets).size).toBe(assets.length);
    for (const asset of assets) expect(asset).toMatch(/^nep141:[a-z0-9.-]+\.(omft|omdep)\.near$/);
  });

  it("has no Chainflip token, no Asset Hub deposit and no fiat source", () => {
    const ids = entries.map(([id]) => id);
    expect(ids).toHaveLength(14);
    expect(ids).not.toContain("flip-ethereum");
    expect(ids.filter((id) => id.endsWith("-assethub") || id.startsWith("meld-"))).toEqual([]);
  });

  it("pays with the same ETH that NEAR delivers on Ethereum", () => {
    expect(INTENTS_SOURCES.eth?.asset).toBe(INTENTS_ETH.ethereum);
  });

  it("marks the three sources on Ethereum and no other", () => {
    const marked = entries.flatMap(([id]) => {
      const kind = INTENTS_SOURCES[id]?.onEthereum;
      return kind === undefined ? [] : [[id, kind]];
    });
    expect(marked).toEqual([
      ["eth", "ether"],
      ["usdc-eth", "token"],
      ["usdt-eth", "token"],
    ]);
  });
});

describe("sourceReach", () => {
  const reach = (id: SourceId, start: "ethereum" | "base"): SourceReach =>
    sourceReach(INTENTS_SOURCES[id]!, start);

  it("sends ETH on Ethereum straight to the key of a route that starts on Ethereum", () => {
    expect(reach("eth", "ethereum")).toBe("direct");
  });

  it.each<SourceId>(["usdc-eth", "usdt-eth"])(
    "sends %s through NEAR for now on a route that starts on Ethereum",
    (id) => {
      expect(reach(id, "ethereum")).toBe("near-for-now");
    },
  );

  it("sends every source on another chain through NEAR, on both routes", () => {
    for (const [id, source] of entries) {
      if (INTENTS_SOURCES[id]?.onEthereum !== undefined) continue;
      expect(sourceReach(source, "ethereum")).toBe("near");
      expect(sourceReach(source, "base")).toBe("near");
    }
  });

  it("sends the sources on Ethereum through NEAR on a route that starts on Base", () => {
    expect(reach("eth", "base")).toBe("near");
    expect(reach("usdc-eth", "base")).toBe("near");
    expect(reach("usdt-eth", "base")).toBe("near");
  });
});
