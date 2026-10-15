// `shareStatusReads`: one status read per id for every reader, and quiet after a 429.

import { describe, expect, it } from "vitest";
import type { MeldClientLike, MeldStatusResult } from "./client";
import { shareStatusReads, type RateLimitCooldown } from "./shared-status";

/** A client counting status reads per id; `answer` is what the next read settles with. */
function countingClient() {
  const reads: Record<string, number> = {};
  const state: { answer: () => Promise<MeldStatusResult> } = {
    answer: async () => ({ status: "session_opened" }),
  };
  const client: MeldClientLike = {
    getQuote: async () => ({ quotes: [] }),
    createSession: async () => {
      throw new Error("unused");
    },
    getStatus: (id) => {
      reads[id] = (reads[id] ?? 0) + 1;
      return state.answer();
    },
    cancel: async () => ({ outcome: "not-found" }),
  };
  return { client, reads, state };
}

/** A cooldown of the test's own, so a 429 here never leaks into the page's. */
const fresh = (): RateLimitCooldown => ({ until: 0, error: null });

const rateLimited = (retryAfterMs?: number) =>
  Object.assign(new Error("Too many requests"), {
    status: 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

describe("shareStatusReads", () => {
  it("shares one in-flight read between concurrent readers of an id", async () => {
    const { client, reads } = countingClient();
    const shared = shareStatusReads(client);
    const [a, b] = await Promise.all([shared.getStatus("mfr"), shared.getStatus("mfr")]);
    expect(reads).toEqual({ mfr: 1 });
    expect(a).toBe(b);
  });

  it("answers from a read younger than the ttl, and reads again after it", async () => {
    let t = 0;
    const { client, reads } = countingClient();
    const shared = shareStatusReads(client, { ttlMs: 2_500, now: () => t });
    await shared.getStatus("mfr");
    t = 2_499;
    await shared.getStatus("mfr");
    expect(reads).toEqual({ mfr: 1 });
    t = 2_500;
    await shared.getStatus("mfr");
    expect(reads).toEqual({ mfr: 2 });
  });

  it("keeps ids apart", async () => {
    const { client, reads } = countingClient();
    const shared = shareStatusReads(client);
    await Promise.all([shared.getStatus("a"), shared.getStatus("b")]);
    expect(reads).toEqual({ a: 1, b: 1 });
  });

  it("never caches an ordinary failure", async () => {
    const { client, reads, state } = countingClient();
    const shared = shareStatusReads(client);
    state.answer = async () => {
      throw Object.assign(new Error("down"), { status: 503 });
    };
    await expect(shared.getStatus("mfr")).rejects.toThrow("down");
    state.answer = async () => ({ status: "transaction_seen" });
    await expect(shared.getStatus("mfr")).resolves.toEqual({ status: "transaction_seen" });
    expect(reads).toEqual({ mfr: 2 });
  });

  it("sends no read for any id until a 429's retry-after has passed", async () => {
    let t = 0;
    const { client, reads, state } = countingClient();
    const shared = shareStatusReads(client, { now: () => t, cooldown: fresh() });
    const refusal = rateLimited(20_000);
    state.answer = async () => {
      throw refusal;
    };
    await expect(shared.getStatus("a")).rejects.toBe(refusal);
    state.answer = async () => ({ status: "session_opened" });
    t = 19_999;
    await expect(shared.getStatus("a")).rejects.toBe(refusal);
    await expect(shared.getStatus("b")).rejects.toBe(refusal);
    expect(reads).toEqual({ a: 1 });
    t = 20_000;
    await expect(shared.getStatus("b")).resolves.toEqual({ status: "session_opened" });
    expect(reads).toEqual({ a: 1, b: 1 });
  });

  it("falls back to its own cooldown when the 429 carries no retry-after", async () => {
    let t = 0;
    const { client, reads, state } = countingClient();
    const shared = shareStatusReads(client, {
      cooldownMs: 10_000,
      now: () => t,
      cooldown: fresh(),
    });
    state.answer = async () => {
      throw rateLimited();
    };
    await expect(shared.getStatus("mfr")).rejects.toMatchObject({ status: 429 });
    state.answer = async () => ({ status: "session_opened" });
    t = 9_999;
    await expect(shared.getStatus("mfr")).rejects.toMatchObject({ status: 429 });
    t = 10_000;
    await expect(shared.getStatus("mfr")).resolves.toEqual({ status: "session_opened" });
    expect(reads).toEqual({ mfr: 2 });
  });

  it("caps a far-off retry-after, so a 429 never holds the reads back past the limit", async () => {
    let t = 0;
    const { client, reads, state } = countingClient();
    const shared = shareStatusReads(client, {
      maxCooldownMs: 60_000,
      now: () => t,
      cooldown: fresh(),
    });
    state.answer = async () => {
      throw rateLimited(3_600_000);
    };
    await expect(shared.getStatus("mfr")).rejects.toMatchObject({ status: 429 });
    state.answer = async () => ({ status: "session_opened" });
    t = 59_999;
    await expect(shared.getStatus("mfr")).rejects.toMatchObject({ status: 429 });
    t = 60_000;
    await expect(shared.getStatus("mfr")).resolves.toEqual({ status: "session_opened" });
    expect(reads).toEqual({ mfr: 2 });
  });

  it("holds back every wrapper on the page after a 429 on one of them", async () => {
    let t = 0;
    const a = countingClient();
    const b = countingClient();
    a.state.answer = async () => {
      throw rateLimited(10_000);
    };
    await expect(shareStatusReads(a.client, { now: () => t }).getStatus("x")).rejects.toMatchObject(
      { status: 429 },
    );
    const other = shareStatusReads(b.client, { now: () => t });
    await expect(other.getStatus("y")).rejects.toMatchObject({ status: 429 });
    expect(b.reads).toEqual({});
    t = 10_000;
    await expect(other.getStatus("y")).resolves.toEqual({ status: "session_opened" });
  });
});
