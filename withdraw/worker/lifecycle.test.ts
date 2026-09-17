import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WorkerHandlers = {
  startWithdraw(params?: unknown): Promise<unknown> | unknown;
  tickAllWithdrawals(params?: unknown): Promise<unknown> | unknown;
};

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  handlers: null as null | WorkerHandlers,
  restoreResult: undefined as unknown,
  startFunding: vi.fn(),
  tickAllFunding: vi.fn(),
  fundingStatus: vi.fn(),
  cancelFunding: vi.fn(),
  startWithdraw: vi.fn(),
  tickAllWithdrawals: vi.fn(),
  withdrawStatus: vi.fn(),
  hasLiveWithdrawals: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("../../worker/src/engine.js", () => ({
  startFunding: mocks.startFunding,
  tickAllFunding: mocks.tickAllFunding,
  fundingStatus: mocks.fundingStatus,
  cancelFunding: mocks.cancelFunding,
}));

vi.mock("../../worker/src/keepalive.js", () => ({
  createKeepAlive: () => ({
    acquire: mocks.acquire,
    release: mocks.release,
    restore: mocks.restore,
  }),
}));

vi.mock("../../worker/src/rpc.js", () => ({
  startRpcDispatcher: ({
    handlers,
  }: {
    handlers: Record<string, (params?: unknown) => Promise<unknown> | unknown>;
  }) => {
    mocks.handlers = handlers as WorkerHandlers;
    return { stop: vi.fn() };
  },
}));

vi.mock("../../withdraw/worker/index.ts", () => ({
  startWithdraw: mocks.startWithdraw,
  tickAllWithdrawals: mocks.tickAllWithdrawals,
  withdrawStatus: mocks.withdrawStatus,
  hasLiveWithdrawals: mocks.hasLiveWithdrawals,
}));

async function importWorker() {
  vi.resetModules();
  // @ts-expect-error worker entry is plain JS; this test narrows the export it needs.
  return (await import("../../worker/src/index.js")) as {
    onEvent(eventName: string): Promise<void>;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.events = [];
  mocks.handlers = null;
  mocks.restoreResult = undefined;
  mocks.startFunding.mockReset().mockResolvedValue({ ok: true });
  mocks.tickAllFunding.mockReset().mockResolvedValue({ ticked: 0, busy: false });
  mocks.fundingStatus.mockReset().mockResolvedValue({});
  mocks.cancelFunding.mockReset().mockResolvedValue({});
  mocks.startWithdraw.mockReset().mockResolvedValue({ known: true, id: "w" });
  mocks.tickAllWithdrawals.mockReset().mockResolvedValue({ ticked: 0, busy: false });
  mocks.withdrawStatus.mockReset().mockResolvedValue({});
  mocks.hasLiveWithdrawals.mockReset().mockResolvedValue(false);
  mocks.acquire.mockReset().mockImplementation(async () => {
    mocks.events.push("acquire");
  });
  mocks.release.mockReset().mockResolvedValue(undefined);
  mocks.restore.mockReset().mockImplementation(async (hasLiveWork: () => Promise<boolean>) => {
    mocks.restoreResult = await hasLiveWork();
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("withdraw worker lifecycle wiring", () => {
  it("checks withdraw liveness during restore without ticking withdrawal side effects", async () => {
    mocks.hasLiveWithdrawals.mockResolvedValue(true);
    await importWorker();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.restoreResult).toBe(true);
    expect(mocks.hasLiveWithdrawals).toHaveBeenCalledTimes(1);
    expect(mocks.tickAllWithdrawals).not.toHaveBeenCalled();
  });

  it("acquires keepalive before ticking live withdrawal work", async () => {
    const worker = await importWorker();
    await Promise.resolve();
    mocks.events = [];
    mocks.hasLiveWithdrawals.mockImplementation(async () => {
      mocks.events.push("has-live");
      return true;
    });
    mocks.tickAllWithdrawals.mockImplementation(async () => {
      mocks.events.push("withdraw-tick");
      return { ticked: 1, busy: false };
    });

    await worker.onEvent("background.wake");

    expect(mocks.events).toEqual(["has-live", "acquire", "withdraw-tick", "acquire"]);
  });

  it("acquires keepalive for a successful startWithdraw handoff only", async () => {
    await importWorker();
    await Promise.resolve();
    expect(mocks.handlers).not.toBeNull();
    const handlers = mocks.handlers;
    if (!handlers) throw new Error("RPC handlers were not registered");
    mocks.acquire.mockClear();

    await handlers.startWithdraw({ id: "ok" });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);

    mocks.acquire.mockClear();
    mocks.startWithdraw.mockResolvedValueOnce({ error: "invalid", reason: "bad" });
    await handlers.startWithdraw({ id: "bad" });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("acquires keepalive before an explicit unknown-withdrawal recovery tick", async () => {
    await importWorker();
    await Promise.resolve();
    const handlers = mocks.handlers;
    if (!handlers) throw new Error("RPC handlers were not registered");
    mocks.events = [];
    mocks.tickAllWithdrawals.mockImplementation(async () => {
      mocks.events.push("withdraw-tick");
      return { ticked: 0, busy: false };
    });

    await handlers.tickAllWithdrawals({ includeUnknown: true });

    expect(mocks.events).toEqual(["acquire", "withdraw-tick"]);
  });

  it("does not let an older idle pump release a newer withdraw handoff", async () => {
    const worker = await importWorker();
    await Promise.resolve();
    const handlers = mocks.handlers;
    if (!handlers) throw new Error("RPC handlers were not registered");
    let finishFunding: ((value: { ticked: number; busy: boolean }) => void) | undefined;
    let finishWithdraw: ((value: { ticked: number; busy: boolean }) => void) | undefined;
    mocks.tickAllFunding.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFunding = resolve;
      }),
    );
    mocks.tickAllWithdrawals.mockReturnValueOnce(
      new Promise((resolve) => {
        finishWithdraw = resolve;
      }),
    );
    mocks.hasLiveWithdrawals.mockResolvedValue(false);
    mocks.acquire.mockClear();
    mocks.release.mockClear();

    const pump = worker.onEvent("background.wake");
    await Promise.resolve();
    await handlers.startWithdraw({ id: "new" });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);

    finishFunding?.({ ticked: 0, busy: false });
    finishWithdraw?.({ ticked: 0, busy: false });
    await pump;

    expect(mocks.release).not.toHaveBeenCalled();
  });
});
