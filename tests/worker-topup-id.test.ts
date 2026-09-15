import { describe, expect, it } from "vitest";
import { topUpIdFor } from "../worker/src/topup-id.js";

const PUBLIC_KEY = new Uint8Array(32).fill(7);

describe("top-up ids", () => {
  it("uses the public key itself for the first attempt", () => {
    expect(topUpIdFor(PUBLIC_KEY, 0)).toBe(PUBLIC_KEY);
  });

  it("derives a distinct, stable 32-byte id for every later attempt", () => {
    const first = topUpIdFor(PUBLIC_KEY, 1);
    const second = topUpIdFor(PUBLIC_KEY, 2);
    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(first).toEqual(topUpIdFor(PUBLIC_KEY, 1));
    expect(first).not.toEqual(second);
    expect(first).not.toEqual(PUBLIC_KEY);
    expect(topUpIdFor(new Uint8Array(32).fill(8), 1)).not.toEqual(first);
  });
});
