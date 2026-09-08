// The storage-backed call channel, both halves over one fake product storage: the page's
// manager (lib/worker-rpc.ts) and the worker's dispatcher (worker/src/rpc.js). Covers
// concurrent calls, slow versus fast handlers, refusals, crashes, unknown apis, and timeouts.

import { afterEach, describe, expect, it, vi } from "vitest";

/** One store shared by both halves, as product storage is. */
const shared = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  return {
    entries,
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

vi.mock("@novasamatech/host-api-wrapper", () => ({ hostLocalStorage: shared.store }));

import { startRpcDispatcher } from "../worker/src/rpc.js";
import { createStorageWorkerManager, WorkerCallError } from "../lib/worker-rpc";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Handlers = Parameters<typeof startRpcDispatcher>[0]["handlers"];

const HANDLERS: Handlers = {
  echo: async (params: { tag?: string }) => ({ echoed: params.tag }),
  slow: async () => {
    await sleep(400);
    return { slow: true };
  },
  refuse: async () => ({ error: "invalid", reason: "settleAmount must be a positive amount" }),
  explode: async () => {
    throw new Error("handler blew up");
  },
};

let cleanup: Array<() => void> = [];

function channel(handlers: Handlers = HANDLERS) {
  const dispatcher = startRpcDispatcher({ handlers, pollMs: 5 });
  // One manager per test over the shared store.
  const manager = createStorageWorkerManager(async () => shared.store as never);
  cleanup.push(
    () => dispatcher.stop(),
    () => manager.dispose(),
  );
  return { dispatcher, manager };
}

afterEach(() => {
  for (const stop of cleanup) stop();
  cleanup = [];
  shared.entries.clear();
});

describe("storage rpc channel", () => {
  it("answers concurrent calls from one manager each with its own result", async () => {
    const { manager } = channel();
    const tags = ["a", "b", "c", "d", "e"];
    const answers = await Promise.all(
      tags.map((tag) => manager.call<{ echoed: string }>("echo", { tag })),
    );
    expect(answers.map((a) => a.echoed)).toEqual(tags);
    // Every call cleaned up after itself: nothing but the heartbeat and the sequence remain.
    const leftover = [...shared.entries.keys()].filter((k) => k.startsWith("getsome.rpc.re"));
    expect(leftover).toEqual([]);
  });

  it("does not hold a fast call behind a slow one", async () => {
    const { manager } = channel();
    const order: string[] = [];
    const slow = manager.call("slow").then(() => order.push("slow"));
    await sleep(10);
    await manager.call("echo", { tag: "fast" }).then(() => order.push("fast"));
    await slow;
    expect(order).toEqual(["fast", "slow"]);
  });

  it("reports a refusal returned as data as an error the caller can act on", async () => {
    const { manager } = channel();
    const failure = await manager.call("refuse").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkerCallError);
    expect((failure as WorkerCallError).tag).toBe("invalid");
    expect((failure as WorkerCallError).message).toContain("positive amount");
  });

  it("reports a throwing handler as crashed and an unknown api as invalid", async () => {
    const { manager } = channel();
    const crashed = await manager.call("explode").catch((e: unknown) => e as WorkerCallError);
    expect(crashed).toMatchObject({ tag: "crashed", message: "crashed: handler blew up" });
    const unknown = await manager.call("nothing").catch((e: unknown) => e as WorkerCallError);
    expect(unknown).toMatchObject({ tag: "invalid", message: "invalid: unknown api nothing" });
  });

  it("times out a call nobody answers, and leaves no request behind for a late worker", async () => {
    const manager = createStorageWorkerManager(async () => shared.store as never);
    cleanup.push(() => manager.dispose());
    await expect(manager.call("echo", { tag: "x" }, { deadlineMs: 300 })).rejects.toMatchObject({
      tag: "timeout",
    });
    expect(shared.entries.get("getsome.rpc.req.1")).toBeUndefined();
  });

  it("answers a request written just before it started, and ignores one long past its caller", async () => {
    // A request written up to 15s before the worker started is still answered.
    const request = (api: string, at: number) => ({ api, payload: { tag: api }, at });
    await shared.store.writeJSON("getsome.rpc.req.1", request("echo", Date.now() - 20_000));
    await shared.store.writeJSON("getsome.rpc.req.2", request("echo", Date.now() - 5_000));
    await shared.store.writeJSON("getsome.rpc.seq", { seq: 2 });
    channel();
    await sleep(60);
    expect(shared.entries.get("getsome.rpc.res.1")).toBeUndefined();
    expect(shared.entries.get("getsome.rpc.res.2")).toMatchObject({ value: { echoed: "echo" } });
  });

  it("reads the worker's heartbeat as availability", async () => {
    const before = createStorageWorkerManager(async () => shared.store as never);
    cleanup.push(() => before.dispose());
    await sleep(5);
    expect(before.isAvailable()).toBe(false);
    const { manager } = channel();
    await sleep(20);
    expect(manager.isAvailable()).toBe(true);
  });
});
