import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IN_FLIGHT, createQueue, type QueueItemKind } from "./queue";

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

const observer = (dropped: QueueItemKind[] = []) => ({
  dropped: (kind: QueueItemKind) => dropped.push(kind),
});

describe("the delivery queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("As a developer reading Sentry, I start the transport late and still receive what was captured before it, in order", async () => {
    // Given
    const started: number[] = [];
    const queue = createQueue<number>();
    const sent = [queue.push(1), queue.push(2), queue.push(3)];

    // When
    queue.setSender(async (item) => (started.push(item), true));

    // Then
    await expect(Promise.all(sent)).resolves.toEqual([true, true, true]);
    expect(started).toEqual([1, 2, 3]);
  });

  it("As a person opening the app in a host, I am never prompted by a send: nothing leaves before the grant, then all of it does, in order", async () => {
    // Given
    const started: number[] = [];
    const queue = createQueue<number>(undefined, undefined, undefined, undefined, true);
    queue.setSender(async (item) => (started.push(item), true));
    const sent = [queue.push(1), queue.push(2)];

    // When: coming back online and the page hiding do not open the gate
    queue.resume();
    queue.flushNow();
    await flush();
    const beforeGrant = [...started];
    queue.open();

    // Then
    expect(beforeGrant).toEqual([]);
    await expect(Promise.all(sent)).resolves.toEqual([true, true]);
    expect(started).toEqual([1, 2]);
  });

  it(`As a person on a slow network, I send a burst of telemetry and never have more than ${MAX_IN_FLIGHT} requests open`, async () => {
    // Given
    let inFlight = 0;
    let most = 0;
    const answers: Array<() => void> = [];
    const queue = createQueue<number>();
    queue.setSender(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          answers.push(() => {
            inFlight -= 1;
            resolve(true);
          });
        }),
    );

    // When
    const sent = Array.from({ length: MAX_IN_FLIGHT + 7 }, (_, item) => queue.push(item));
    await flush();
    for (const answer of answers.splice(0)) answer();
    await flush();
    for (const answer of answers.splice(0)) answer();

    // Then
    await expect(Promise.all(sent)).resolves.toEqual(Array(MAX_IN_FLIGHT + 7).fill(true));
    expect(most).toBe(MAX_IN_FLIGHT);
  });

  it("As a developer reading Sentry, I overfill the queue and lose metrics before events", async () => {
    // Given
    const dropped: QueueItemKind[] = [];
    const queue = createQueue<number>(3, Date.now, observer(dropped));

    // When
    const metric = queue.push(1, true);
    const events = [queue.push(2), queue.push(3), queue.push(4)];
    queue.setSender(async () => true);

    // Then
    await expect(metric).resolves.toBe(false);
    await expect(Promise.all(events)).resolves.toEqual([true, true, true]);
    expect(dropped).toEqual(["metric"]);
  });

  it("As a developer reading Sentry, I hit a thrown send and still receive the event, and the session keeps sending", async () => {
    // Given
    let calls = 0;
    const queue = createQueue<number>();
    queue.setSender(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return true;
    });

    // When
    const first = queue.push(1);
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await expect(first).resolves.toBe(true);
    await expect(queue.push(2)).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it("As a developer reading Sentry, I get a Retry-After from the server and the whole queue waits it out", async () => {
    // Given
    let calls = 0;
    const queue = createQueue<number>();
    queue.setSender(async () => {
      calls += 1;
      return calls === 1 ? { failed: "429", retryAfterMs: 30_000, statusCode: 429 } : true;
    });

    // When
    const first = queue.push(1);
    await flush();
    const second = queue.push(2);
    await vi.advanceTimersByTimeAsync(29_999);

    // Then
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("As a person who went offline, I come back online and my telemetry is sent in order", async () => {
    // Given
    let online = false;
    const delivered: number[] = [];
    const queue = createQueue<number>();
    queue.setSender(async (item) => {
      if (!online) return "offline";
      delivered.push(item);
      return true;
    });
    const sent = [queue.push(1), queue.push(2)];
    await flush();

    // When
    online = true;
    queue.resume();

    // Then
    await expect(Promise.all(sent)).resolves.toEqual([true, true]);
    expect(delivered).toEqual([1, 2]);
  });

  it("As a person closing the app, I hide the page and held telemetry starts at once instead of after its backoff", async () => {
    // Given
    let online = false;
    const started: number[] = [];
    const queue = createQueue<number>();
    queue.setSender(async (item) => {
      started.push(item);
      return online ? true : "offline";
    });
    const sent = queue.push(1);
    await flush();

    // When
    online = true;
    queue.flushNow();

    // Then
    await expect(sent).resolves.toBe(true);
    expect(started).toEqual([1, 1]);
  });
});
