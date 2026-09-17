import type { WithdrawJobView, WithdrawStatusView } from "../worker/rpc";
import {
  prepareWithdrawHandoff,
  shouldAdoptPending,
  shouldClearPending,
  type PendingHandoffRead,
  type PendingWithdrawHandoff,
} from "./model";

export interface WithdrawControllerSnapshot {
  initialized: boolean;
  pending: PendingWithdrawHandoff | null;
  pendingBlockedReason: string | null;
  status: WithdrawStatusView | null;
  workerError: string | null;
  starting: boolean;
  resuming: boolean;
  refreshing: boolean;
  handoffUncertain: boolean;
}

export interface WithdrawControllerDeps {
  readPending(): Promise<PendingHandoffRead>;
  writePending(handoff: PendingWithdrawHandoff): Promise<void>;
  clearPending(): Promise<void>;
  start(handoff: PendingWithdrawHandoff): Promise<WithdrawStatusView>;
  status(id?: string): Promise<WithdrawStatusView>;
  resume(): Promise<void>;
  createId(): `0x${string}`;
  now(): number;
  messageOf(error: unknown): string;
}

export interface StartResult {
  kind: "started" | "ignored" | "blocked" | "uncertain";
  reason?: string;
}

type Listener = (snapshot: WithdrawControllerSnapshot) => void;

export function createWithdrawController(deps: WithdrawControllerDeps) {
  let snapshot: WithdrawControllerSnapshot = {
    initialized: false,
    pending: null,
    pendingBlockedReason: null,
    status: null,
    workerError: null,
    starting: false,
    resuming: false,
    refreshing: false,
    handoffUncertain: false,
  };
  let disposed = false;
  let generation = 0;
  let statusGeneration = 0;
  let identityGeneration = 0;
  const listeners = new Set<Listener>();

  function getSnapshot(): WithdrawControllerSnapshot {
    return snapshot;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(snapshot);
    return () => listeners.delete(listener);
  }

  function publish(patch: Partial<WithdrawControllerSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener(snapshot);
  }

  function activeJob(): WithdrawJobView | null {
    return snapshot.status?.known === true ? snapshot.status : null;
  }

  function blocksNewWithdrawal(): boolean {
    const job = activeJob();
    return (
      snapshot.pendingBlockedReason !== null ||
      snapshot.pending !== null ||
      (!!job && job.phase !== "done" && job.phase !== "failed")
    );
  }

  async function initialize(): Promise<void> {
    if (snapshot.starting || snapshot.resuming) return;
    const run = ++generation;
    const identity = identityGeneration;
    statusGeneration += 1;
    publish({ initialized: false, pendingBlockedReason: null, refreshing: false });
    try {
      const read = await deps.readPending();
      if (disposed || run !== generation || identity !== identityGeneration) return;
      if (read.kind === "blocked") {
        publish({ initialized: true, pendingBlockedReason: read.reason, pending: null });
        return;
      }
      publish({ pending: read.pending, pendingBlockedReason: null });
      const recovered = await refresh({ quiet: true });
      if (!disposed && run === generation && identity === identityGeneration) {
        publish(
          recovered
            ? { initialized: true }
            : {
                initialized: true,
                pendingBlockedReason:
                  "Withdrawal status is unavailable. Retry when the host is ready.",
              },
        );
      }
    } catch (error) {
      if (!disposed && run === generation) {
        publish({ initialized: true, pendingBlockedReason: deps.messageOf(error) });
      }
    }
  }

  async function start(amount: string): Promise<StartResult> {
    if (disposed || snapshot.starting) return { kind: "ignored" };
    if (!snapshot.initialized)
      return { kind: "blocked", reason: "Withdrawal state is still loading." };
    if (snapshot.pendingBlockedReason) {
      return { kind: "blocked", reason: snapshot.pendingBlockedReason };
    }
    if (blocksNewWithdrawal()) {
      return { kind: "blocked", reason: "A withdrawal is already in progress." };
    }

    const plan = prepareWithdrawHandoff({
      pending: snapshot.pending,
      amount,
      createId: deps.createId,
      now: deps.now,
    });
    if (plan.kind === "blocked") return { kind: "blocked", reason: plan.reason };

    identityGeneration += 1;
    statusGeneration += 1;
    const identity = identityGeneration;
    publish({
      starting: true,
      refreshing: false,
      workerError: null,
      status: null,
      handoffUncertain: false,
    });
    let persisted = false;
    try {
      await deps.writePending(plan.handoff);
      persisted = true;
      if (disposed || identity !== identityGeneration) return { kind: "ignored" };
      publish({ pending: plan.handoff });
      const next = await deps.start(plan.handoff);
      if (disposed || identity !== identityGeneration) return { kind: "ignored" };
      await applyStatus(next, identity);
      publish({ handoffUncertain: false });
      return { kind: "started" };
    } catch (error) {
      if (!persisted) {
        if (!disposed && identity === identityGeneration) {
          publish({
            pending: plan.handoff,
            handoffUncertain: true,
            workerError: `Withdrawal could not be saved. Retry before leaving this page. ${deps.messageOf(
              error,
            )}`,
          });
        }
        return { kind: "blocked", reason: deps.messageOf(error) };
      }
      if (!disposed && isWorkerInvalid(error)) {
        const reconciled = await reconcileInvalidStart(plan.handoff, error);
        if (reconciled) return reconciled;
      }
      if (!disposed) {
        publish({
          handoffUncertain: true,
          workerError: `The withdrawal has not confirmed yet. The saved payment ID will be reused. ${deps.messageOf(
            error,
          )}`,
        });
      }
      return { kind: "uncertain", reason: deps.messageOf(error) };
    } finally {
      if (!disposed) publish({ starting: false });
    }
  }

  async function refresh(options: { quiet: boolean }): Promise<boolean> {
    if (disposed || snapshot.refreshing) return false;
    if (snapshot.starting || snapshot.resuming) return false;
    const run = ++statusGeneration;
    const identity = identityGeneration;
    publish({ refreshing: true });
    try {
      const next = await deps.status(snapshot.pending?.id);
      if (disposed || run !== statusGeneration || identity !== identityGeneration) return false;
      await applyStatus(next, identity);
      if (next.known === false && next.reason) {
        publish({ pendingBlockedReason: next.reason, workerError: next.reason });
      } else if (!options.quiet) {
        publish({ workerError: null });
      }
      return true;
    } catch (error) {
      if (!disposed && run === statusGeneration && (!options.quiet || snapshot.pending !== null)) {
        publish({ workerError: deps.messageOf(error) });
      }
      return false;
    } finally {
      if (!disposed && run === statusGeneration) publish({ refreshing: false });
    }
  }

  async function resume(): Promise<void> {
    if (disposed || snapshot.starting || snapshot.resuming || !canResumeSnapshot(snapshot)) return;
    identityGeneration += 1;
    statusGeneration += 1;
    const identity = identityGeneration;
    publish({ resuming: true, refreshing: false, workerError: null });
    try {
      if (snapshot.pending && !hasMatchingKnownStatus(snapshot.status, snapshot.pending.id)) {
        try {
          await deps.writePending(snapshot.pending);
          if (disposed || identity !== identityGeneration) return;
          const next = await deps.start(snapshot.pending);
          if (disposed || identity !== identityGeneration) return;
          await applyStatus(next, identity);
        } catch (error) {
          if (isWorkerInvalid(error)) {
            const reconciled = await reconcileInvalidStart(snapshot.pending, error, identity);
            if (reconciled) return;
          }
          throw error;
        }
      }
      await deps.resume();
      if (!disposed && identity === identityGeneration) publish({ handoffUncertain: false });
      await readAfterResume();
    } catch (error) {
      if (!disposed) publish({ workerError: deps.messageOf(error) });
    } finally {
      if (!disposed) publish({ resuming: false });
    }
  }

  async function readAfterResume(): Promise<void> {
    const run = ++statusGeneration;
    const identity = identityGeneration;
    publish({ refreshing: true });
    try {
      const next = await deps.status(snapshot.pending?.id);
      if (disposed || run !== statusGeneration || identity !== identityGeneration) return;
      await applyStatus(next, identity);
      publish({ workerError: null });
    } catch (error) {
      if (!disposed && run === statusGeneration && identity === identityGeneration) {
        publish({ workerError: deps.messageOf(error) });
      }
    } finally {
      if (!disposed && run === statusGeneration) publish({ refreshing: false });
    }
  }

  async function applyStatus(next: WithdrawStatusView, identity: number): Promise<void> {
    if (disposed || identity !== identityGeneration) return;
    if (snapshot.pending && next.known === true && next.id !== snapshot.pending.id) return;
    publish({ status: next });
    if (shouldClearPending(snapshot.pending, next)) {
      try {
        await deps.clearPending();
        if (!disposed && identity === identityGeneration) {
          publish({ pending: null, handoffUncertain: false });
        }
      } catch (error) {
        if (!disposed && identity === identityGeneration)
          publish({ workerError: deps.messageOf(error) });
      }
      return;
    }
    if (!snapshot.pending) {
      const adopted = shouldAdoptPending(next);
      if (adopted) {
        await deps.writePending(adopted);
        if (!disposed && identity === identityGeneration) publish({ pending: adopted });
      }
    }
  }

  async function reconcileInvalidStart(
    handoff: PendingWithdrawHandoff,
    error: unknown,
    identity = identityGeneration,
  ): Promise<StartResult | null> {
    try {
      const latest = await deps.status();
      if (disposed || identity !== identityGeneration) return { kind: "ignored" };
      if (latest.known === false && latest.reason) {
        publish({ pendingBlockedReason: latest.reason, workerError: latest.reason });
        return { kind: "blocked", reason: latest.reason };
      }
      if (
        latest.known === true &&
        latest.id !== handoff.id &&
        latest.phase !== "done" &&
        latest.phase !== "failed"
      ) {
        await deps.clearPending();
        if (disposed || identity !== identityGeneration) return { kind: "ignored" };
        publish({ pending: null, handoffUncertain: false });
        await applyStatus(latest, identity);
        return { kind: "blocked", reason: "Another withdrawal is already in progress." };
      }
    } catch {
      return null;
    }
    return { kind: "blocked", reason: deps.messageOf(error) };
  }

  function dispose(): void {
    disposed = true;
    generation += 1;
    statusGeneration += 1;
    identityGeneration += 1;
    listeners.clear();
  }

  return {
    snapshot: getSnapshot,
    subscribe,
    initialize,
    start,
    refresh,
    resume,
    dispose,
  };
}

export function canResumeSnapshot(snapshot: WithdrawControllerSnapshot): boolean {
  const job = snapshot.status?.known === true ? snapshot.status : null;
  const pendingHasKnownStatus =
    snapshot.pending !== null && hasMatchingKnownStatus(snapshot.status, snapshot.pending.id);
  return (
    snapshot.handoffUncertain ||
    (!!snapshot.pending && !pendingHasKnownStatus) ||
    job?.phase === "unknown"
  );
}

function hasMatchingKnownStatus(
  status: WithdrawStatusView | null,
  pendingId: string,
): status is WithdrawJobView {
  return status?.known === true && status.id === pendingId;
}

function isWorkerInvalid(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { tag?: unknown }).tag === "invalid";
}
