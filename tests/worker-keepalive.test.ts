// The keep-alive bracket over the host's operation API, with the host scripted. Covers
// persisting and clearing the operation id, keeping it across a refused close, and a new
// instance adopting a live predecessor's operation or closing an orphaned one.

import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    beginOperation: vi.fn(),
    endOperation: vi.fn(),
    store: {
      readJSON: async (key: string) => entries.get(key) ?? null,
      writeJSON: async (key: string, value: unknown) => {
        entries.set(key, JSON.parse(JSON.stringify(value)));
      },
      clear: async (key: string) => {
        entries.delete(key);
      },
    },
  };
});

vi.mock("@novasamatech/host-api-wrapper", () => ({
  hostWorker: { beginOperation: host.beginOperation, endOperation: host.endOperation },
  hostLocalStorage: host.store,
}));

import { createKeepAlive } from "../worker/src/keepalive.js";

const OPERATION_KEY = "getsome.keepalive.op";

afterEach(() => {
  host.entries.clear();
  host.beginOperation.mockReset();
  host.endOperation.mockReset();
});

describe("keep-alive", () => {
  it("opens once, persists the id, and clears it when the host closes the operation", async () => {
    host.beginOperation.mockResolvedValue(41);
    host.endOperation.mockResolvedValue(undefined);
    const keepAlive = createKeepAlive();
    await keepAlive.acquire();
    await keepAlive.acquire(); // idempotent while held
    expect(host.beginOperation).toHaveBeenCalledTimes(1);
    expect(host.entries.get(OPERATION_KEY)).toMatchObject({ id: 41 });
    expect(keepAlive.isHeld()).toBe(true);

    await keepAlive.release();
    expect(host.endOperation).toHaveBeenCalledExactlyOnceWith(41);
    expect(host.entries.has(OPERATION_KEY)).toBe(false);
    expect(keepAlive.isHeld()).toBe(false);
  });

  it("keeps the id when the host refuses to close, and closes it on the next release", async () => {
    host.beginOperation.mockResolvedValue(7);
    host.endOperation.mockRejectedValueOnce(new Error("host busy")).mockResolvedValue(undefined);
    const keepAlive = createKeepAlive();
    await keepAlive.acquire();

    await keepAlive.release();
    // Still held, still on record.
    expect(keepAlive.isHeld()).toBe(true);
    expect(host.entries.get(OPERATION_KEY)).toMatchObject({ id: 7 });

    await keepAlive.release();
    expect(host.endOperation).toHaveBeenCalledTimes(2);
    expect(keepAlive.isHeld()).toBe(false);
    expect(host.entries.has(OPERATION_KEY)).toBe(false);
  });

  it("adopts a predecessor's operation while work is live, and closes an orphan", async () => {
    host.entries.set(OPERATION_KEY, { id: 12, label: "funding", at: 1 });
    host.endOperation.mockResolvedValue(undefined);

    const successor = createKeepAlive();
    await successor.restore(async () => true);
    expect(successor.isHeld()).toBe(true);
    expect(host.endOperation).not.toHaveBeenCalled();
    await successor.release();
    expect(host.endOperation).toHaveBeenCalledExactlyOnceWith(12);

    host.entries.set(OPERATION_KEY, { id: 13, label: "funding", at: 1 });
    const idle = createKeepAlive();
    await idle.restore(async () => false);
    expect(host.endOperation).toHaveBeenLastCalledWith(13);
    expect(idle.isHeld()).toBe(false);
    expect(host.entries.has(OPERATION_KEY)).toBe(false);
  });

  it("gives an id up after repeated refusals: the host no longer knows it", async () => {
    host.beginOperation.mockResolvedValueOnce(20).mockResolvedValueOnce(21);
    host.endOperation.mockRejectedValue(new Error("unknown operation"));
    const keepAlive = createKeepAlive();
    await keepAlive.acquire();
    await keepAlive.release();
    await keepAlive.release();
    expect(keepAlive.isHeld()).toBe(true);
    await keepAlive.release();
    expect(host.endOperation).toHaveBeenCalledTimes(3);
    expect(keepAlive.isHeld()).toBe(false);
    expect(host.entries.has(OPERATION_KEY)).toBe(false);
    // A dropped id no longer blocks the next job's operation.
    await keepAlive.acquire();
    expect(host.entries.get(OPERATION_KEY)).toMatchObject({ id: 21 });
  });

  it("holds on to an orphan the host would not close, so a later release can", async () => {
    host.entries.set(OPERATION_KEY, { id: 5, label: "funding", at: 1 });
    host.endOperation.mockRejectedValueOnce(new Error("host busy")).mockResolvedValue(undefined);
    const keepAlive = createKeepAlive();
    await keepAlive.restore(async () => false);
    expect(keepAlive.isHeld()).toBe(true);
    expect(host.entries.get(OPERATION_KEY)).toMatchObject({ id: 5 });

    await keepAlive.release();
    expect(keepAlive.isHeld()).toBe(false);
    expect(host.entries.has(OPERATION_KEY)).toBe(false);
  });
});
