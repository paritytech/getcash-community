import { reEnter, type ReEnterInput } from "@getsome/core";
import { describe, expect, it } from "vitest";
import { createFakeHarness, type Harness } from "./fakes";

const FUNDED = 13_000_000_000n; // price + ~0.3 DOT overhead, in plancks
const RECIPIENT = "5RecipientConnectedAccount00000000000000000000";

function input(h: Harness): ReEnterInput<unknown> {
  return {
    action: h.action,
    chain: h.chain,
    signer: h.signer,
    sourceId: "btc",
    recipient: RECIPIENT,
    settlement: { kind: "native" },
    key: "attempt-key-1",
    payload: {},
    priceEvm: 1_000_000_000_000_000_000n,
    requiredBalance: FUNDED,
    retryDelayMs: 0,
  };
}

describe("reEnter, the funds-safety invariant", () => {
  it("probes isComplete first and never submits when the action is already complete", async () => {
    const h = createFakeHarness({ balance: 999_000_000_000n, startComplete: true });
    const out = await reEnter(input(h));

    expect(out.phase).toBe("done");
    if (out.phase === "done") expect(out.receipt.id).toBe(42);
    expect(h.stats.probes).toBeGreaterThanOrEqual(1);
    expect(h.stats.submits).toBe(0); // no double-spend: never submitted
    expect(h.stats.builds).toBe(0);
  });

  it("scopes the probe to this attempt via the idempotency key", async () => {
    const h = createFakeHarness({ balance: FUNDED });
    await reEnter(input(h));
    expect(h.stats.probedKeys.every((k) => k === "attempt-key-1")).toBe(true);
  });

  it("does NOT re-submit when a prior submit errored but the tx actually landed (idempotent retry)", async () => {
    const h = createFakeHarness({ balance: FUNDED, failSubmits: 1, failButLand: true });
    const out = await reEnter(input(h));

    expect(out.phase).toBe("done");
    // Exactly one submit: it threw, but the post-error re-probe found the landed tx; no second
    // submit.
    expect(h.stats.submits).toBe(1);
    expect(h.stats.complete).toBe(true);
  });

  it("stays in awaiting-deposit and never submits while under-funded", async () => {
    const h = createFakeHarness({ balance: FUNDED - 1n });
    const out = await reEnter(input(h));

    expect(out.phase).toBe("awaiting-deposit");
    expect(h.stats.submits).toBe(0);
  });

  it("submits once with the settle-back plan (dest = recipient) on the happy path", async () => {
    const h = createFakeHarness({ balance: FUNDED });
    const out = await reEnter(input(h));

    expect(out.phase).toBe("done");
    expect(h.stats.submits).toBe(1);
    expect(h.stats.builds).toBe(1);
    // The library owns the settle-back: every submit carries the plan.
    expect(h.stats.lastSettle?.dest).toBe(RECIPIENT);
    expect(h.stats.lastSettle?.settlement).toEqual({ kind: "native" });
  });

  it('retries up to max, then fails recoverably ("funds are safe") when nothing lands', async () => {
    const h = createFakeHarness({ balance: FUNDED, failSubmits: 5, failButLand: false });
    const out = await reEnter({ ...input(h), maxAttempts: 3 });

    expect(out.phase).toBe("failed");
    if (out.phase === "failed") {
      expect(out.failure.kind).toBe("mint");
      expect(out.failure.recoverable).toBe(true);
    }
    expect(h.stats.submits).toBe(3); // bounded by maxAttempts
  });
});
