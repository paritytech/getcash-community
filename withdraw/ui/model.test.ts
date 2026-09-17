import { describe, expect, it, vi } from "vitest";
import type { WithdrawJobView } from "../worker/rpc";
import {
  PENDING_WITHDRAW_KEY,
  formatWithdrawAmount,
  parseWithdrawAmount,
  prepareWithdrawHandoff,
  readPendingWithdrawHandoff,
  shouldClearPending,
  withdrawAmountState,
  withdrawPresentation,
  writePendingWithdrawHandoff,
  type PendingHandoffStore,
  type PendingWithdrawHandoff,
} from "./model";

const ID1 = `0x${"11".repeat(32)}` as const;
const ID2 = `0x${"22".repeat(32)}` as const;
const NOW = 1_700_000_000_000;

function store(initial?: unknown): PendingHandoffStore & { value: unknown } {
  return {
    value: initial ?? null,
    async readJSON(key: string) {
      expect(key).toBe(PENDING_WITHDRAW_KEY);
      return this.value;
    },
    async writeJSON(key: string, value: unknown) {
      expect(key).toBe(PENDING_WITHDRAW_KEY);
      this.value = JSON.parse(JSON.stringify(value));
    },
    async clear(key: string) {
      expect(key).toBe(PENDING_WITHDRAW_KEY);
      this.value = null;
    },
  };
}

function job(input: Partial<WithdrawJobView> = {}): WithdrawJobView {
  const createdAt = input.createdAt ?? NOW;
  return {
    v: 1,
    known: true,
    id: input.id ?? ID1,
    amount: input.amount ?? "1000000",
    label: input.label ?? `getcash:withdraw:v1:${input.id ?? ID1}`,
    phase: input.phase ?? "payment-pending",
    done: input.done ?? false,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
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

describe("withdraw amount", () => {
  it("parses and formats exact six-decimal CASH amounts", () => {
    expect(parseWithdrawAmount("18.123456")).toBe(18_123_456n);
    expect(parseWithdrawAmount("18.1234567")).toBeNull();
    expect(parseWithdrawAmount("001")).toBeNull();
    expect(formatWithdrawAmount(18_120_000n)).toBe("18.12");
    expect(formatWithdrawAmount(18_000_000n, { minDecimals: 2 })).toBe("18.00");
  });

  it("requires a positive amount strictly below the live balance", () => {
    expect(withdrawAmountState("0", 2_000_000n).kind).toBe("too-low");
    expect(withdrawAmountState("2", 2_000_000n).kind).toBe("too-high");
    expect(withdrawAmountState("1.999999", 2_000_000n)).toMatchObject({
      kind: "valid",
      baseUnits: 1_999_999n,
    });
  });
});

describe("withdraw pending handoff", () => {
  const pending: PendingWithdrawHandoff = { id: ID1, amount: "1000000", createdAt: NOW };

  it("reads and writes the saved handoff through host product storage", async () => {
    const hostStore = store();

    await writePendingWithdrawHandoff(hostStore, pending);

    await expect(readPendingWithdrawHandoff(hostStore)).resolves.toEqual({
      kind: "ok",
      pending,
    });
  });

  it("fails closed when host storage is unavailable or malformed", async () => {
    await expect(readPendingWithdrawHandoff(null)).resolves.toMatchObject({ kind: "blocked" });
    await expect(readPendingWithdrawHandoff(store({ id: "bad" }))).resolves.toMatchObject({
      kind: "blocked",
    });
    await expect(
      readPendingWithdrawHandoff({
        readJSON: vi.fn(async () => {
          throw new Error("storage down");
        }),
        writeJSON: vi.fn(),
        clear: vi.fn(),
      }),
    ).resolves.toMatchObject({ kind: "blocked" });
  });

  it("reuses the same id for the same saved amount and blocks amount changes", () => {
    expect(
      prepareWithdrawHandoff({
        pending,
        amount: "1000000",
        createId: () => ID2,
        now: () => NOW + 1,
      }),
    ).toEqual({ kind: "ready", handoff: pending, reused: true });
    expect(
      prepareWithdrawHandoff({
        pending,
        amount: "2000000",
        createId: () => ID2,
        now: () => NOW + 1,
      }),
    ).toMatchObject({ kind: "blocked" });
    expect(
      prepareWithdrawHandoff({
        pending: null,
        amount: "2000000",
        createId: () => ID2,
        now: () => NOW + 1,
      }),
    ).toEqual({
      kind: "ready",
      reused: false,
      handoff: { id: ID2, amount: "2000000", createdAt: NOW + 1 },
    });
  });

  it("clears a saved handoff only for the same terminal withdrawal", () => {
    expect(shouldClearPending(pending, job({ phase: "done", done: true }))).toBe(true);
    expect(shouldClearPending(pending, job({ id: ID2, phase: "done", done: true }))).toBe(false);
    expect(shouldClearPending(pending, job({ phase: "unknown" }))).toBe(false);
  });
});

describe("withdraw status presentation", () => {
  it("renders partial settlement against the requested amount", () => {
    const view = withdrawPresentation(
      job({
        phase: "awaiting-people-credit",
        payment: {
          id: ID1,
          requestedAmount: "1000000",
          status: "partiallyClaimed",
          actualClaimed: "250000",
        },
      }),
      null,
      null,
    );

    expect(view.detail).toContain("0.25 CASH");
    expect(view.detail).toContain("1 CASH");
  });

  it("keeps proven completed steps on an unknown Asset Hub arrival", () => {
    const view = withdrawPresentation(
      job({
        phase: "unknown",
        payment: {
          id: ID1,
          requestedAmount: "1000000",
          status: "completed",
          actualClaimed: "1000000",
        },
        peopleCredit: { target: "1000000", balance: "1000000", finalizedAt: NOW },
        submission: {
          phase: "finalized",
          attempts: 1,
          at: NOW,
          expectedPUsd: "700000",
          ok: true,
        },
      }),
      null,
      null,
    );

    expect(view.steps.map((step) => step.state)).toEqual(["done", "done", "done", "unknown"]);
  });

  it("does not mark the batch step done for a pending submission marker", () => {
    const view = withdrawPresentation(
      job({
        phase: "awaiting-asset-hub-credit",
        payment: {
          id: ID1,
          requestedAmount: "1000000",
          status: "completed",
          actualClaimed: "1000000",
        },
        peopleCredit: { target: "1000000", balance: "1000000", finalizedAt: NOW },
        submission: { phase: "pending", attempts: 1, at: NOW, expectedPUsd: "700000" },
      }),
      null,
      null,
    );

    expect(view.steps.map((step) => step.state)).toEqual(["done", "done", "waiting", "current"]);
  });

  it("marks the next unproven step as failed without erasing prior facts", () => {
    const view = withdrawPresentation(
      job({
        phase: "failed",
        failure: "pre-submit-failed",
        payment: {
          id: ID1,
          requestedAmount: "1000000",
          status: "completed",
          actualClaimed: "1000000",
        },
        peopleCredit: { target: "1000000", balance: "1000000", finalizedAt: NOW },
      }),
      null,
      null,
    );

    expect(view.steps.map((step) => step.state)).toEqual(["done", "done", "failed", "waiting"]);
  });
});
