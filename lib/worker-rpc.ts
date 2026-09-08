import { getHostLocalStorage } from "@parity/product-sdk-host";

/** The error vocabulary of the worker seam. The tag is for the log. */
export type WorkerErrorTag =
  "unavailable" | "denied" | "invalid" | "timeout" | "crashed" | "version";

export class WorkerCallError extends Error {
  constructor(
    public readonly tag: WorkerErrorTag,
    reason?: string,
  ) {
    super(reason ? `${tag}: ${reason}` : tag);
    this.name = "WorkerCallError";
  }
}

/**
 * Storage-backed call channel, page half; mirrors `worker/src/rpc.js`. Shape-compatible with
 * the SDK's `getWorkerManager()`. Requests are left in the product storage both executables share.
 */
const SEQ_KEY = "getsome.rpc.seq";
const HEARTBEAT_KEY = "getsome.rpc.alive";
const requestKey = (seq: number) => `getsome.rpc.req.${seq}`;
const responseKey = (seq: number) => `getsome.rpc.res.${seq}`;
const claimKey = (seq: number) => `getsome.rpc.claim.${seq}`;

/** A worker that has not written a beat within this window is treated as gone. */
const LIVENESS_WINDOW_MS = 15_000;
/** How long an unclaimed call waits before it fails. */
const DEFAULT_DEADLINE_MS = 8_000;
/** Extra wait once the worker has claimed the call. */
const CLAIMED_GRACE_MS = 20_000;
const POLL_MS = 250;

const ERROR_TAGS: readonly WorkerErrorTag[] = [
  "unavailable",
  "denied",
  "invalid",
  "timeout",
  "crashed",
  "version",
];

function toErrorTag(value: string): WorkerErrorTag {
  return (ERROR_TAGS as readonly string[]).includes(value)
    ? (value as WorkerErrorTag)
    : "unavailable";
}

export interface StorageWorker {
  isAvailable(): boolean;
  call<T>(apiName: string, payload?: unknown, options?: { deadlineMs?: number }): Promise<T>;
  dispose(): void;
}

type HostStore = NonNullable<Awaited<ReturnType<typeof getHostLocalStorage>>>;
type Answer = { value?: unknown; error?: string; reason?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let shared: StorageWorker | null = null;

/** The page's one manager. A single allocator bumps the stored sequence. */
export function getStorageWorkerManager(): StorageWorker {
  shared ??= createStorageWorkerManager();
  return shared;
}

/** A fresh manager over `getStore`. Production goes through getStorageWorkerManager. */
export function createStorageWorkerManager(
  getStore: () => Promise<HostStore | null | undefined> = getHostLocalStorage,
): StorageWorker {
  let alive = false;
  // Serializes the read-bump-write of the sequence, and only that.
  let allocating: Promise<unknown> = Promise.resolve();

  const liveness = setInterval(() => void refreshLiveness(), 2_000);
  void refreshLiveness();

  async function refreshLiveness(): Promise<void> {
    try {
      const store = await getStore();
      const beat = (await store?.readJSON(HEARTBEAT_KEY)) as { at?: number } | null;
      alive = !!beat?.at && Date.now() - beat.at < LIVENESS_WINDOW_MS;
    } catch {
      alive = false;
    }
  }

  async function allocate(store: HostStore, apiName: string, payload: unknown): Promise<number> {
    const seq = Number(((await store.readJSON(SEQ_KEY)) as { seq?: number } | null)?.seq ?? 0) + 1;
    // Request first, sequence second: the worker reads forward from the sequence.
    await store.writeJSON(requestKey(seq), {
      api: apiName,
      payload: payload ?? {},
      at: Date.now(),
    });
    await store.writeJSON(SEQ_KEY, { seq });
    return seq;
  }

  function allocateSerially(store: HostStore, apiName: string, payload: unknown): Promise<number> {
    const next = allocating.then(
      () => allocate(store, apiName, payload),
      () => allocate(store, apiName, payload),
    );
    allocating = next.catch(() => undefined);
    return next;
  }

  async function send<T>(apiName: string, payload: unknown, deadlineMs: number): Promise<T> {
    const store = await getStore();
    if (!store) throw new WorkerCallError("unavailable", "no product storage on this page");
    const seq = await allocateSerially(store, apiName, payload);
    try {
      const answer = await poll(store, seq, deadlineMs);
      if (answer.error) throw new WorkerCallError(toErrorTag(answer.error), answer.reason);
      return answer.value as T;
    } finally {
      // Cleared on every outcome, timeouts included.
      await store.clear(requestKey(seq)).catch(() => {});
      await store.clear(responseKey(seq)).catch(() => {});
      await store.clear(claimKey(seq)).catch(() => {});
    }
  }

  async function poll(store: HostStore, seq: number, deadlineMs: number): Promise<Answer> {
    let until = Date.now() + deadlineMs;
    let extendedForClaim = false;
    let answer = (await store.readJSON(responseKey(seq))) as Answer | null;
    while (!answer) {
      if (Date.now() > until) {
        // A claimed call is executing; wait for the worker's own verdict.
        if (!extendedForClaim && (await store.readJSON(claimKey(seq)))) {
          extendedForClaim = true;
          until = Date.now() + CLAIMED_GRACE_MS;
        } else {
          throw new WorkerCallError(
            "timeout",
            `worker did not answer request #${seq} in ${deadlineMs}ms`,
          );
        }
      }
      await sleep(POLL_MS);
      answer = (await store.readJSON(responseKey(seq))) as Answer | null;
    }
    return answer;
  }

  return {
    isAvailable: () => alive,
    call: <T>(apiName: string, payload?: unknown, options?: { deadlineMs?: number }) =>
      send<T>(apiName, payload, options?.deadlineMs ?? DEFAULT_DEADLINE_MS),
    dispose: () => clearInterval(liveness),
  };
}
