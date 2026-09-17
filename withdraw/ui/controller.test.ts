import { describe, expect, it, vi } from "vitest";
import { WorkerCallError } from "~~/lib/worker-rpc";
import type { WithdrawJobView, WithdrawStatusView } from "../worker/rpc";
import {
  createWithdrawController,
  type WithdrawControllerDeps,
  type WithdrawControllerSnapshot,
} from "./controller";
import type { PendingHandoffRead, PendingWithdrawHandoff } from "./model";

const ID1 = `0x${"11".repeat(32)}` as const;
const ID2 = `0x${"22".repeat(32)}` as const;
const NOW = 1_700_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  return { promise, resolve, reject };
}

function known(input: Partial<WithdrawJobView> = {}): WithdrawJobView {
  return {
    v: 1,
    known: true,
    id: input.id ?? ID1,
    amount: input.amount ?? "1000000",
    label: input.label ?? `getcash:withdraw:v1:${input.id ?? ID1}`,
    phase: input.phase ?? "payment-pending",
    done: input.done ?? false,
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
    lastTickAt: input.lastTickAt ?? null,
    lastError: input.lastError,
    failure: input.failure,
    account: input.account,
    payment: input.payment,
    peopleCredit: input.peopleCredit,
    prepared: input.prepared,
    submission: input.submission,
    assetHubCredit: input.assetHubCredit,
  };
}

function deps(overrides: Partial<WithdrawControllerDeps> = {}) {
  let saved: PendingWithdrawHandoff | null = null;
  const base: WithdrawControllerDeps = {
    readPending: vi.fn(async (): Promise<PendingHandoffRead> => ({ kind: "ok", pending: saved })),
    writePending: vi.fn(async (handoff) => {
      saved = handoff;
    }),
    clearPending: vi.fn(async () => {
      saved = null;
    }),
    start: vi.fn(async (handoff): Promise<WithdrawStatusView> => known({ id: handoff.id })),
    status: vi.fn(async (): Promise<WithdrawStatusView> => ({ known: false })),
    resume: vi.fn(async () => {}),
    createId: vi.fn(() => ID1),
    now: vi.fn(() => NOW),
    messageOf: (error) => (error instanceof Error ? error.message : String(error)),
  };
  return { deps: { ...base, ...overrides }, saved: () => saved };
}

describe("withdraw controller", () => {
  it("serializes start so a double click cannot create two ids", async () => {
    const write = deferred<void>();
    const test = deps({
      writePending: vi.fn(async () => write.promise),
      start: vi.fn(async (handoff): Promise<WithdrawStatusView> => known({ id: handoff.id })),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    const first = controller.start("1000000");
    const second = await controller.start("1000000");

    expect(second).toEqual({ kind: "ignored" });
    expect(test.deps.createId).toHaveBeenCalledTimes(1);
    expect(test.deps.writePending).toHaveBeenCalledTimes(1);
    write.resolve();
    await first;
    expect(test.deps.start).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain handoff and resumes with the same id after a timeout", async () => {
    const test = deps({
      start: vi
        .fn()
        .mockRejectedValueOnce(new WorkerCallError("timeout", "slow"))
        .mockImplementation(async (handoff: PendingWithdrawHandoff) => known({ id: handoff.id })),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    await expect(controller.start("1000000")).resolves.toMatchObject({ kind: "uncertain" });
    expect(controller.snapshot()).toMatchObject({
      pending: { id: ID1, amount: "1000000" },
      handoffUncertain: true,
    });

    await controller.resume();

    expect(test.deps.start).toHaveBeenCalledTimes(2);
    expect(test.deps.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: ID1, amount: "1000000" }),
    );
  });

  it("clears an old done status when a new handoff is uncertain and resumes the new id", async () => {
    const test = deps({
      createId: vi.fn(() => ID2),
      status: vi.fn(async () => known({ id: ID1, phase: "done", done: true })),
      start: vi
        .fn()
        .mockRejectedValueOnce(new WorkerCallError("timeout", "slow"))
        .mockImplementation(async (handoff: PendingWithdrawHandoff) => known({ id: handoff.id })),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID1 });

    await expect(controller.start("1000000")).resolves.toMatchObject({ kind: "uncertain" });

    expect(controller.snapshot()).toMatchObject({
      pending: { id: ID2, amount: "1000000" },
      status: null,
      handoffUncertain: true,
    });

    await controller.resume();

    expect(test.deps.start).toHaveBeenCalledTimes(2);
    expect(test.deps.start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: ID2, amount: "1000000" }),
    );
    expect(test.deps.start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: ID2, amount: "1000000" }),
    );
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID2 });
  });

  it("does not call the worker when pending persistence fails before handoff", async () => {
    const test = deps({
      writePending: vi
        .fn()
        .mockRejectedValueOnce(new Error("storage down"))
        .mockImplementation(async () => {}),
      start: vi.fn(async (handoff): Promise<WithdrawStatusView> => known({ id: handoff.id })),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    await expect(controller.start("1000000")).resolves.toMatchObject({
      kind: "blocked",
      reason: "storage down",
    });

    expect(test.deps.start).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      pending: { id: ID1, amount: "1000000" },
      handoffUncertain: true,
    });
    expect(controller.snapshot().workerError).toContain("could not be saved");

    await controller.resume();

    expect(test.deps.writePending).toHaveBeenCalledTimes(2);
    expect(test.deps.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: ID1, amount: "1000000" }),
    );
  });

  it("ignores a delayed status poll after a new handoff starts", async () => {
    const oldStatus = deferred<WithdrawStatusView>();
    const test = deps({
      status: vi
        .fn()
        .mockResolvedValueOnce({ known: false })
        .mockImplementation(() => oldStatus.promise),
      start: vi.fn(async (handoff): Promise<WithdrawStatusView> => known({ id: handoff.id })),
    });
    const controller = createWithdrawController(test.deps);
    const states: WithdrawControllerSnapshot[] = [];
    controller.subscribe((snapshot) => states.push(snapshot));
    await controller.initialize();

    const poll = controller.refresh({ quiet: true });
    await expect(controller.start("1000000")).resolves.toMatchObject({ kind: "started" });
    oldStatus.resolve(known({ id: ID2, phase: "done", done: true }));
    await poll;

    expect(test.deps.start).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().pending?.id).toBe(ID1);
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID1 });
    expect(states.at(-1)?.pending?.id).toBe(ID1);
  });

  it("does not let initialization retry invalidate an in-flight start", async () => {
    const start = deferred<WithdrawStatusView>();
    const test = deps({
      start: vi.fn(() => start.promise),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    const run = controller.start("1000000");
    await Promise.resolve();
    await controller.initialize();

    start.resolve(known({ id: ID1 }));
    await run;

    expect(test.deps.readPending).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID1 });
  });

  it("does not let resume invalidate an in-flight start", async () => {
    const start = deferred<WithdrawStatusView>();
    const test = deps({
      start: vi.fn(() => start.promise),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    const run = controller.start("1000000");
    await Promise.resolve();
    await controller.resume();

    start.resolve(known({ id: ID1 }));
    await run;

    expect(test.deps.start).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID1 });
  });

  it("fails closed when the initial status recovery cannot complete", async () => {
    const test = deps({
      status: vi.fn(async () => {
        throw new Error("worker unavailable");
      }),
    });
    const controller = createWithdrawController(test.deps);

    await controller.initialize();

    expect(controller.snapshot()).toMatchObject({
      initialized: true,
      pendingBlockedReason: "Withdrawal status is unavailable. Retry when the host is ready.",
    });
    await expect(controller.start("1000000")).resolves.toMatchObject({ kind: "blocked" });
  });

  it("does not start a new handoff while terminal cleanup is still clearing storage", async () => {
    const pending: PendingWithdrawHandoff = { id: ID1, amount: "1000000", createdAt: NOW };
    const clear = deferred<void>();
    const test = deps({
      readPending: vi.fn(async () => ({ kind: "ok" as const, pending })),
      clearPending: vi.fn(async () => clear.promise),
      status: vi
        .fn()
        .mockResolvedValueOnce({ known: false })
        .mockResolvedValueOnce(known({ phase: "done", done: true })),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    const refresh = controller.refresh({ quiet: true });
    await Promise.resolve();
    await expect(controller.start("1000000")).resolves.toMatchObject({ kind: "blocked" });

    clear.resolve();
    await refresh;
    expect(controller.snapshot().pending).toBeNull();
  });

  it("ignores delayed async work after dispose", async () => {
    const start = deferred<WithdrawStatusView>();
    const test = deps({ start: vi.fn(() => start.promise) });
    const controller = createWithdrawController(test.deps);
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.initialize();
    const run = controller.start("1000000");
    controller.dispose();

    start.resolve(known({ phase: "done", done: true }));
    await run;

    const callsAfterDispose = listener.mock.calls.length;
    await Promise.resolve();
    expect(listener.mock.calls.length).toBe(callsAfterDispose);
  });

  it("adopts the active worker job after a definitive active-job refusal", async () => {
    const active = known({ id: ID2, phase: "payment-pending" });
    const test = deps({
      start: vi.fn(async () => {
        throw new WorkerCallError("invalid", "another withdrawal is already active");
      }),
      status: vi
        .fn()
        .mockResolvedValueOnce({ known: false })
        .mockImplementation(async (id?: string) => (id ? { known: false, id } : active)),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    await expect(controller.start("1000000")).resolves.toMatchObject({ kind: "blocked" });

    expect(test.saved()).toMatchObject({ id: ID2 });
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID2 });
  });

  it("reconciles an invalid resume handoff after reload", async () => {
    const pending: PendingWithdrawHandoff = { id: ID1, amount: "1000000", createdAt: NOW };
    const active = known({ id: ID2, phase: "payment-pending" });
    const test = deps({
      readPending: vi.fn(async () => ({ kind: "ok" as const, pending })),
      start: vi.fn(async () => {
        throw new WorkerCallError("invalid", "another withdrawal is already active");
      }),
      status: vi
        .fn()
        .mockResolvedValueOnce({ known: false, id: ID1 })
        .mockImplementation(async (id?: string) => (id ? { known: false, id } : active)),
    });
    const controller = createWithdrawController(test.deps);
    await controller.initialize();

    await controller.resume();

    expect(test.deps.start).toHaveBeenCalledExactlyOnceWith(pending);
    expect(test.saved()).toMatchObject({ id: ID2 });
    expect(controller.snapshot().status).toMatchObject({ known: true, id: ID2 });
  });
});
