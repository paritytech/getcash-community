// The index of open requests. Entries are keyed on (sourceId, tradeN): the trade counter is
// per source, and meld-card #1 and dot-assethub #1 are different requests.

import { describe, expect, it } from "vitest";
import {
  parseRequestIndex,
  parseRequestRefKey,
  requestRefKey,
  requestRefOf,
  sameRequestRef,
  serializeRequestIndex,
} from "../app/utils/request-index";

describe("request index", () => {
  it("round-trips newest first, de-duped by (sourceId, tradeN)", () => {
    const out = parseRequestIndex(
      serializeRequestIndex([
        { sourceId: "dot-assethub", tradeN: 2 },
        { sourceId: "meld-card", tradeN: 1 },
        { sourceId: "dot-assethub", tradeN: 2 }, // exact duplicate -> dropped
        { sourceId: "dot-assethub", tradeN: 1 }, // same tradeN as meld-card #1, different source -> kept
      ]),
    );
    // The exact duplicate is gone, both #1s survive, and the higher trade number sorts first.
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ sourceId: "dot-assethub", tradeN: 2 });
    expect(out.filter((r) => r.tradeN === 1)).toEqual(
      expect.arrayContaining([
        { sourceId: "meld-card", tradeN: 1 },
        { sourceId: "dot-assethub", tradeN: 1 },
      ]),
    );
  });

  it("migrates the old bare-number format to source-less refs", () => {
    // Pre-source-aware entries are plain trade numbers and read as refs with no source id.
    expect(parseRequestIndex("[2, 7, 2, 5]")).toEqual([
      { tradeN: 7 },
      { tradeN: 5 },
      { tradeN: 2 },
    ]);
  });

  it("reads absent, empty and corrupt storage as no open requests", () => {
    expect(parseRequestIndex(null)).toEqual([]);
    expect(parseRequestIndex("")).toEqual([]);
    expect(parseRequestIndex("not json")).toEqual([]);
    expect(parseRequestIndex('{"n":1}')).toEqual([]);
  });

  it("drops junk entries instead of the whole index", () => {
    // Old numbers and new objects mix; junk values are dropped individually.
    expect(parseRequestIndex('[3, "x", null, 0, -2, 1.5, {"tradeN":1}]')).toEqual([
      { tradeN: 3 },
      { tradeN: 1 },
    ]);
  });
});

describe("request ref keys", () => {
  it("keys a ref as source#tradeN, with an empty source for a pre-source-aware ref", () => {
    expect(requestRefKey({ sourceId: "meld-card", tradeN: 3 })).toBe("meld-card#3");
    expect(requestRefKey({ tradeN: 7 })).toBe("#7");
    expect(requestRefOf(undefined, 7)).toEqual({ tradeN: 7 });
    expect(requestRefOf("dot-assethub", 7)).toEqual({ sourceId: "dot-assethub", tradeN: 7 });
  });

  it("parses a key back to the same ref and rejects anything else", () => {
    expect(parseRequestRefKey("meld-card#3")).toEqual({ sourceId: "meld-card", tradeN: 3 });
    expect(parseRequestRefKey("#7")).toEqual({ tradeN: 7 });
    expect(parseRequestRefKey("x#0")).toBeNull();
    expect(parseRequestRefKey("#")).toBeNull();
    expect(parseRequestRefKey("a#b")).toBeNull();
    expect(parseRequestRefKey("7")).toBeNull();
  });

  it("compares refs by both parts", () => {
    expect(sameRequestRef({ tradeN: 1 }, { tradeN: 1 })).toBe(true);
    expect(sameRequestRef({ sourceId: "meld-card", tradeN: 1 }, { tradeN: 1 })).toBe(false);
    expect(
      sameRequestRef({ sourceId: "meld-card", tradeN: 1 }, { sourceId: "dot-assethub", tradeN: 1 }),
    ).toBe(false);
  });
});
