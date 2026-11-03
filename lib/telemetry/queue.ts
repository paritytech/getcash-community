/**
 * THE DELIVERY QUEUE: bounded, concurrent and retrying.
 *
 * No send result closes telemetry for the page session. Failed sends are
 * retried with backoff;
 * offline sends remain held until `resume()`; and metrics are displaced
 * before events when the queue reaches its cap.
 *
 * The queue starts sends synchronously, up to MAX_IN_FLIGHT, so the group of
 * envelopes produced by pagehide reaches the browser transport before the
 * page is torn down. The sender and observer are injected, keeping this file
 * independent of Sentry, storage and the browser.
 */
const QUEUE_CAP = 200;
/** The browser fetch transport's request buffer. */
export const MAX_IN_FLIGHT = 40;
/** Initial send plus this many retries. */
const PER_ITEM_RETRY_LIMIT = 5;
/** A transport that never answers is itself a failed upload. */
const SEND_TIMEOUT_MS = 15_000;
/** After the request timeout, keep the ambiguous claim briefly so a late
 * success can still win without a duplicate. A sender that never settles must
 * not keep queue capacity or pagehide flushes alive forever. */
const SEND_UNCERTAIN_FOLLOW_MS = 60_000;

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

type SendFailureReason = "fetch" | "4xx" | "429" | "5xx" | "timeout";
export type SendAnswer =
  | true
  | "offline"
  | { delivered: true; retryAfterMs: number }
  | {
      failed: SendFailureReason;
      /** server-derived: holds the whole queue, whatever the failure class */
      retryAfterMs?: number;
      statusCode?: number;
      locallyRateLimited?: boolean;
    };
export type QueueItemKind = "event" | "metric";
type Sender<T> = (item: T) => Promise<SendAnswer>;

/** What the queue tells its owner: an item it gave up on. */
interface QueueObserver {
  dropped(kind: QueueItemKind): void;
}

const NOOP_OBSERVER: QueueObserver = { dropped: () => {} };

export interface DeliveryQueue<T> {
  push(item: T, metric?: boolean): Promise<boolean>;
  /** Resumes delivery after the browser reports `online`. */
  resume(): void;
  /** Page teardown: skip item backoff/offline holding and start queued work now.
   * A server Retry-After remains authoritative for the whole queue. */
  flushNow(): void;
  size(): number;
  setSender(send: Sender<T>): void;
}

export interface RateLimitDeadlineStore {
  load(): number;
  save(until: number): void;
}

const NOOP_RATE_LIMIT_STORE: RateLimitDeadlineStore = {
  load: () => 0,
  save: () => {},
};

export function createQueue<T>(
  cap = QUEUE_CAP,
  now: () => number = Date.now,
  observer: QueueObserver = NOOP_OBSERVER,
  rateLimitStore: RateLimitDeadlineStore = NOOP_RATE_LIMIT_STORE,
): DeliveryQueue<T> {
  type Entry = {
    item: T;
    kind: QueueItemKind;
    queuedAt: number;
    readyAt: number;
    retries: number;
    settle(sent: boolean): void;
  };

  let paused = false;
  let sender: Sender<T> | null = null;
  let inFlight = 0;
  let uncertain = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let rateLimitedUntil = Math.max(0, rateLimitStore.load());
  const held: Entry[] = [];

  const drop = (entry: Entry) => {
    observer.dropped(entry.kind);
    entry.settle(false);
  };

  const makeRoom = (entry: Entry): boolean => {
    if (held.length + inFlight + uncertain < cap) return true;
    const metric = held.findIndex((candidate) => candidate.kind === "metric");
    if (metric >= 0) drop(held.splice(metric, 1)[0]!);
    else if (entry.kind === "metric" || held.length === 0) {
      drop(entry);
      return false;
    } else drop(held.shift()!);
    return true;
  };

  const enqueue = (entry: Entry) => {
    if (makeRoom(entry)) held.push(entry);
  };

  const extendRateLimit = (retryAfterMs: number) => {
    const until = now() + Math.max(0, retryAfterMs);
    if (until <= rateLimitedUntil) return;
    rateLimitedUntil = until;
    rateLimitStore.save(until);
  };

  const schedule = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (paused || sender === null || held.length === 0 || inFlight >= MAX_IN_FLIGHT) return;
    const nextAt = Math.max(rateLimitedUntil, Math.min(...held.map((entry) => entry.readyAt)));
    if (nextAt <= now()) return;
    retryTimer = setTimeout(pump, nextAt - now());
  };

  const start = (entry: Entry) => {
    inFlight += 1;
    let timedOut = false;
    let abandoned = false;
    let uncertainTimer: ReturnType<typeof setTimeout> | undefined;
    let slotHeld = true;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      inFlight -= 1;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      uncertain += 1;
      releaseSlot();
      uncertainTimer = setTimeout(() => {
        abandoned = true;
        uncertain -= 1;
        drop(entry);
        pump();
      }, SEND_UNCERTAIN_FOLLOW_MS);
      pump();
    }, SEND_TIMEOUT_MS);
    let sending: Promise<SendAnswer>;
    try {
      sending = Promise.resolve(sender!(entry.item)).catch((): SendAnswer => ({ failed: "fetch" }));
    } catch {
      sending = Promise.resolve({ failed: "fetch" });
    }
    void sending.then((answer) => {
      if (
        answer !== true &&
        answer !== "offline" &&
        ("delivered" in answer || answer.failed === "429" || answer.retryAfterMs !== undefined)
      ) {
        // Requests already in flight cannot obey a header they have not seen.
        // Keep them claimed, but start no later sender invocation before the
        // longest Retry-After returned by any of those requests has expired.
        const retryAfterMs =
          answer.retryAfterMs ??
          RETRY_BACKOFF_MS[Math.min(entry.retries, RETRY_BACKOFF_MS.length - 1)];
        extendRateLimit(retryAfterMs);
        if (abandoned) pump();
      }
      if (abandoned) return;
      clearTimeout(timeout);
      clearTimeout(uncertainTimer);
      releaseSlot();
      if (timedOut) uncertain -= 1;
      if (answer === true || (answer !== "offline" && "delivered" in answer)) {
        entry.settle(true);
      } else if (answer !== "offline" && answer.locallyRateLimited) {
        // The SDK did not issue a request (its own category limiter or local
        // transport buffer rejected it), so this is neither a failed network
        // attempt nor an ambiguous delivery. Keep the item without consuming
        // its retry budget, including when the queue timeout fired first.
        entry.readyAt = rateLimitedUntil;
        enqueue(entry);
      } else if (timedOut && (answer === "offline" || answer.statusCode === undefined)) {
        // Once the caller's timeout has fired, an answer without an HTTP
        // status is still ambiguous: retrying it can duplicate a send that
        // reached the server. Bound and drop the claim instead.
        drop(entry);
      } else if (answer === "offline") {
        paused = true;
        enqueue(entry);
        held.sort((a, b) => a.queuedAt - b.queuedAt);
      } else {
        // A timed-out fetch may still complete: retrying it can duplicate an
        // event or metric while its outcome is unknown. A late definite
        // failure removes that ambiguity, so it is safe to retry normally.
        if (entry.retries < PER_ITEM_RETRY_LIMIT) {
          entry.retries += 1;
          entry.readyAt =
            answer.failed === "429" || answer.retryAfterMs !== undefined
              ? rateLimitedUntil
              : now() + (answer.retryAfterMs ?? RETRY_BACKOFF_MS[entry.retries - 1]!);
          enqueue(entry);
        } else drop(entry);
      }
      pump();
    });
  };

  function pump(): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (paused || sender === null) return;
    if (rateLimitedUntil > now()) {
      schedule();
      return;
    }
    while (inFlight < MAX_IN_FLIGHT) {
      const ready = held.findIndex((entry) => entry.readyAt <= now());
      if (ready < 0) break;
      start(held.splice(ready, 1)[0]!);
    }
    schedule();
  }

  return {
    push(item, metric = false) {
      return new Promise<boolean>((settle) => {
        const at = now();
        enqueue({
          item,
          kind: metric ? "metric" : "event",
          queuedAt: at,
          readyAt: at,
          retries: 0,
          settle,
        });
        pump();
      });
    },
    resume() {
      paused = false;
      pump();
    },
    flushNow() {
      paused = false;
      const at = now();
      for (const entry of held) entry.readyAt = at;
      pump();
    },
    size: () => held.length + inFlight + uncertain,
    setSender(send) {
      sender = send;
      pump();
    },
  };
}
