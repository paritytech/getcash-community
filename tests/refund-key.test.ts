// Per-request refund keys: labels, storage slots and the fail-closed provisioning.

import { describe, expect, it } from "vitest";
import type { SourceId } from "@getsome/core";
import { SOURCE_CONFIGS } from "@getsome/chainflip";
import {
  createMockCoinageSession,
  depositLanded,
  provisionRefundKey,
  refundChainFor,
  refundEntropyLabel,
  refundStorageKey,
} from "../lib/coinage";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    read: async (k: string) => map.get(k) ?? null,
    write: async (k: string, v: string) => void map.set(k, v),
    map,
  };
}

const entropy = {
  async deriveSeed(label: Uint8Array) {
    const out = new Uint8Array(32);
    label.forEach((b, i) => {
      out[i % 32] = ((out[i % 32] ?? 0) ^ b) + 1;
    });
    return out;
  },
};

const deps = () => ({ entropy, storage: memoryStorage() });

describe("refund key labels and slots", () => {
  it("fits the host's 32-byte key limit for the longest source id and an 8-digit counter", () => {
    const longest = SOURCE_CONFIGS.map((s) => s.sourceId).sort((a, b) => b.length - a.length)[0]!;
    const label = refundEntropyLabel(longest, 99_999_999);
    expect(label.length).toBeLessThanOrEqual(32);
    expect(new TextDecoder().decode(refundEntropyLabel("btc", 7))).toBe("onramp:rf:btc:7");
  });

  it("never shares a label with the burner", () => {
    expect(new TextDecoder().decode(refundEntropyLabel("btc", 1))).not.toContain("onramp:eph");
  });

  it("keys storage by source and trade", () => {
    expect(refundStorageKey("usdc-solana", 12)).toBe("coinage:refund:usdc-solana:12");
  });

  it("maps every Chainflip source to a chain and the manual rail to none", () => {
    for (const source of SOURCE_CONFIGS) expect(refundChainFor(source.sourceId)).toBe(source.chain);
    expect(refundChainFor("dot-assethub")).toBeNull();
  });
});

describe("provisionRefundKey", () => {
  it("records the key's address in the trade's slot, never its secret", async () => {
    const d = deps();
    const key = await provisionRefundKey(d, "btc", 3, "mainnet");
    expect(key?.chain).toBe("Bitcoin");
    const raw = d.storage.map.get(refundStorageKey("btc", 3))!;
    expect(JSON.parse(raw)).toEqual({ chain: "Bitcoin", address: key?.address, format: "wif" });
    expect(raw).not.toContain(key?.secret);
  });

  it("is deterministic per (source, trade) and differs across trades and sources", async () => {
    const a = await provisionRefundKey(deps(), "eth", 1, "mainnet");
    const b = await provisionRefundKey(deps(), "eth", 1, "mainnet");
    const c = await provisionRefundKey(deps(), "eth", 2, "mainnet");
    const d = await provisionRefundKey(deps(), "usdc-eth", 1, "mainnet");
    expect(a).toEqual(b);
    expect(a?.address).not.toBe(c?.address);
    expect(a?.address).not.toBe(d?.address);
  });

  it("returns null for the manual rail and writes nothing", async () => {
    const d = deps();
    expect(await provisionRefundKey(d, "dot-assethub", 1, "mainnet")).toBeNull();
    expect(d.storage.map.size).toBe(0);
  });

  it("accepts a slot that already holds the same key without rewriting it", async () => {
    const d = deps();
    const first = await provisionRefundKey(d, "sol-solana", 5, "mainnet");
    d.storage.map.set(
      refundStorageKey("sol-solana", 5),
      `${d.storage.map.get(refundStorageKey("sol-solana", 5))} `,
    );
    const second = await provisionRefundKey(d, "sol-solana", 5, "mainnet");
    expect(second).toEqual(first);
    expect(d.storage.map.get(refundStorageKey("sol-solana", 5))!.endsWith(" ")).toBe(true);
  });

  it("refuses a slot whose stored key disagrees with the derivation", async () => {
    const d = deps();
    const stale = await provisionRefundKey(d, "trx-tron", 1, "mainnet");
    d.storage.map.set(
      refundStorageKey("trx-tron", 2),
      JSON.stringify({ ...stale, address: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC" }),
    );
    await expect(provisionRefundKey(d, "trx-tron", 2, "mainnet")).rejects.toThrow(/does not match/);
  });

  it("refuses when the write cannot be read back", async () => {
    const storage = { read: async () => null, write: async () => {} };
    await expect(provisionRefundKey({ entropy, storage }, "btc", 1, "mainnet")).rejects.toThrow(
      /could not be stored/,
    );
  });

  it("propagates an entropy failure", async () => {
    const failing = {
      deriveSeed: async () => {
        throw new Error("no entropy");
      },
    };
    await expect(
      provisionRefundKey({ entropy: failing, storage: memoryStorage() }, "btc", 1, "mainnet"),
    ).rejects.toThrow(/no entropy/);
  });
});

describe("depositLanded", () => {
  it("is true from the moment the burner holds the deposit", () => {
    for (const phase of ["funded", "working", "done"]) expect(depositLanded(phase)).toBe(true);
    for (const phase of ["awaiting-deposit", "swapping", "failed", undefined]) {
      expect(depositLanded(phase)).toBe(false);
    }
  });
});

describe("createMockCoinageSession", () => {
  it("holds a refund key for the source's chain: the secret in memory, the address on record", async () => {
    const sourceId: SourceId = "usdt-tron";
    const world = await createMockCoinageSession({ recipient: "r", amount: 1n, sourceId });
    const key = world.revealRefundKey();
    expect(key?.chain).toBe("Tron");
    expect(world.refundAddress).toBe(key?.address);
    const raw = await world.storage.read(refundStorageKey(sourceId, 1));
    expect(JSON.parse(raw!)).toMatchObject({ chain: "Tron", address: key?.address });
    expect(raw).not.toContain(key?.secret);
    world.session.dispose();
  });
});
