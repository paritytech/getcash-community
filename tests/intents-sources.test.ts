// The NEAR asset table against the catalog of crypto sources: each source has an asset, and the
// table names nothing the catalog does not have.

import { describe, expect, it } from "vitest";
import { SOURCE_CONFIGS } from "@getsome/chainflip";
import { INTENTS_SOURCES } from "@getsome/intents";

describe("INTENTS_SOURCES against the source catalog", () => {
  it("has an asset for every source but FLIP, which NEAR does not list", () => {
    const missing = SOURCE_CONFIGS.map((source) => source.sourceId).filter(
      (id) => INTENTS_SOURCES[id] === undefined,
    );
    expect(missing).toEqual(["flip-ethereum"]);
  });

  it("names no source the catalog does not have", () => {
    const known = new Set<string>(SOURCE_CONFIGS.map((source) => source.sourceId));
    expect(Object.keys(INTENTS_SOURCES).filter((id) => !known.has(id))).toEqual([]);
  });

  it("marks as on Ethereum the sources the catalog puts there", () => {
    for (const source of SOURCE_CONFIGS) {
      const entry = INTENTS_SOURCES[source.sourceId];
      if (entry === undefined) continue;
      const expected =
        source.chain !== "Ethereum" ? undefined : source.asset === "ETH" ? "ether" : "token";
      expect(entry.onEthereum, source.sourceId).toBe(expected);
    }
  });
});
