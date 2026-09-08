import { createFlowStore, FLOW_SCHEMA_VERSION, flowStorageKey } from "@getsome/core";
import { describe, expect, it } from "vitest";
import { createMemoryAdapter } from "./memory-adapter";

describe("flow store", () => {
  it("keys by sourceId + recipient so concurrent sources for one recipient never collide", () => {
    expect(flowStorageKey("btc", "5Alice")).toBe(`onramp:v${FLOW_SCHEMA_VERSION}:btc:5Alice`);
    expect(flowStorageKey("eth", "5Alice")).not.toBe(flowStorageKey("btc", "5Alice"));
  });

  it("round-trips a flow state and treats a foreign schema version as absent (no mis-read)", async () => {
    const storage = createMemoryAdapter();
    const store = createFlowStore(storage, "btc", "5Alice");

    expect(await store.load()).toBeNull();

    await store.save({
      version: FLOW_SCHEMA_VERSION,
      mode: "spend",
      sourceId: "btc",
      recipient: "5Alice",
      ephemeralAddress: "5Eph",
      phase: "awaiting-deposit",
      createdAt: 0,
      idempotencyKey: "attempt-key-1",
      payload: "deadbeef",
      priceEvm: "1000000000000000000",
      settlement: { kind: "native" },
    });

    const loaded = await store.load();
    expect(loaded?.phase).toBe("awaiting-deposit");
    expect(loaded?.idempotencyKey).toBe("attempt-key-1");

    // A future/foreign version must not be mis-parsed as v1.
    await storage.write(flowStorageKey("btc", "5Alice"), JSON.stringify({ version: 99 }));
    expect(await store.load()).toBeNull();

    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
