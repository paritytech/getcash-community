// Per-request refund keys: labels, storage slots and the fail-closed provisioning.

import { describe, expect, it } from "vitest";
import type { SourceId } from "@getsome/core";
import { formatSourceAmount, SOURCE_CONFIG_BY_ID, SOURCE_CONFIGS } from "@getsome/chainflip";
import {
  createMockCoinageSession,
  depositLanded,
  provisionRefundKey,
  recoverRefundKey,
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

describe("recovering a refund key after the fact", () => {
  it("returns the key the request was opened with, from its identity alone", async () => {
    // The whole point: a refund can be walked back to long after the world that created it is
    // gone, because the key is a pure function of (sourceId, n) and both are on the record.
    const provisioned = await provisionRefundKey(deps(), "usdt-tron", 7, "testnet");
    const recovered = await recoverRefundKey(entropy, "usdt-tron", 7);
    expect(recovered).not.toBeNull();
    expect(recovered?.address).toBe(provisioned?.address);
    expect(recovered?.secret).toBe(provisioned?.secret);
  });

  it("does not need the stored slot, so a cleared one cannot strand the funds", async () => {
    // It takes no storage at all: the slot is a record of what was handed to the rail, not the
    // source of the key. A request whose slot was pruned is still recoverable, and reading one
    // cannot write a secret back for a request that should no longer have it.
    const store = memoryStorage();
    const recovered = await recoverRefundKey(entropy, "usdt-tron", 42);
    expect(recovered?.address).toBeTruthy();
    expect(store.map.size).toBe(0);
    // Same key as provisioning would have produced, with nothing ever stored for it.
    const provisioned = await provisionRefundKey(
      { entropy, storage: store },
      "usdt-tron",
      42,
      "testnet",
    );
    expect(provisioned?.address).toBe(recovered?.address);
  });

  it("gives a different key per request, so one refund cannot spend another's", async () => {
    const seven = await recoverRefundKey(entropy, "usdt-tron", 7);
    const eight = await recoverRefundKey(entropy, "usdt-tron", 8);
    const other = await recoverRefundKey(entropy, "usdt-solana", 7);
    expect(seven?.address).not.toBe(eight?.address);
    expect(seven?.address).not.toBe(other?.address);
  });

  it("fails closed on a source with no refund chain", async () => {
    expect(refundChainFor("dot-assethub" as SourceId)).toBeNull();
    expect(await recoverRefundKey(entropy, "dot-assethub" as SourceId, 1)).toBeNull();
  });
});

describe("the refund amount a record carries", () => {
  const btc = SOURCE_CONFIG_BY_ID.get("btc" as SourceId)!;

  it("is base units, which is what the guide renders it from", () => {
    // The rail reports base units and the record stores them verbatim. Seeding a decimal string
    // instead threw inside the guide's own heading and blanked the whole screen.
    expect(formatSourceAmount(btc, "43000")).toBe("0.00043");
  });

  it("throws on a decimal string, so nothing may render one unguarded", () => {
    expect(() => formatSourceAmount(btc, "0.00043")).toThrow();
  });
});
