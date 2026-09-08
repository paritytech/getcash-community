// Per-trade ephemeral rotation: the pure pieces (counter, labels, enumeration).

import { describe, expect, it } from "vitest";
import {
  enumerateTradeBurners,
  isRequestStarted,
  readTradeCounter,
  tradeCounterKey,
  tradeEntropyLabel,
} from "../lib/coinage";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    read: async (k: string) => map.get(k) ?? null,
    write: async (k: string, v: string) => void map.set(k, v),
    map,
  };
}

/** Deterministic fake entropy: 32 bytes folded from the label (mock-mode style). */
const entropy = {
  deterministic: true as const,
  async deriveSeed(label: Uint8Array) {
    const out = new Uint8Array(32);
    label.forEach((b, i) => {
      out[i % 32] = ((out[i % 32] ?? 0) ^ b) & 0xff;
    });
    return out;
  },
};

const RECIPIENT = "13ENScfFZXQ8avXf6cphack516B8YCjdL4MJbodm7VxK8GE9";

describe("trade counter", () => {
  it("defaults to 1 when missing or malformed; reads a stored value", async () => {
    expect(await readTradeCounter(memoryStorage(), "dot-assethub")).toBe(1);
    const junk = memoryStorage({ [tradeCounterKey("dot-assethub")]: "banana" });
    expect(await readTradeCounter(junk, "dot-assethub")).toBe(1);
    const stored = memoryStorage({ [tradeCounterKey("dot-assethub")]: "7" });
    expect(await readTradeCounter(stored, "dot-assethub")).toBe(7);
  });

  it("labels carry no account: the trade number is the only thing that varies", () => {
    const dec = new TextDecoder();
    const l1 = dec.decode(tradeEntropyLabel("dot-assethub", 1));
    const l2 = dec.decode(tradeEntropyLabel("dot-assethub", 2));
    expect(l1).toBe("onramp:eph:dot-assethub:1");
    expect(l2).toBe("onramp:eph:dot-assethub:2");
    expect(l1).not.toContain(RECIPIENT);
  });

  it("enumerates every past burner up to the counter, all with distinct addresses", async () => {
    const storage = memoryStorage({ [tradeCounterKey("dot-assethub")]: "3" });
    const burners = await enumerateTradeBurners({ entropy, storage, sourceId: "dot-assethub" });
    expect(burners.map((b) => b.n)).toEqual([1, 2, 3]);
    expect(new Set(burners.map((b) => b.address)).size).toBe(3);
  });
});

describe("when a request takes its burner for good", () => {
  // The trade number is claimed at this boundary.
  it("is started once a deposit address exists, and stays started to the end", () => {
    for (const phase of ["awaiting-deposit", "swapping", "funded", "working", "done"]) {
      expect(isRequestStarted(phase)).toBe(true);
    }
  });

  it("is not started while nothing has been published yet", () => {
    for (const phase of ["idle", "quoting", "quoted"]) {
      expect(isRequestStarted(phase)).toBe(false);
    }
  });

  it("does not treat 'failed' as the start", () => {
    // A failure is reached through a started phase, which already claimed the number.
    expect(isRequestStarted("failed")).toBe(false);
  });
});
