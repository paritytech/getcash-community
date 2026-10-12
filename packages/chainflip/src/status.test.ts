import { describe, expect, it } from "vitest";
import type { ChainflipProgressFacts } from "@getsome/core";
import { getSwapStatus, isImplicitFailure, type StatusBackend } from "./status";

function backendReturning(payload: unknown): StatusBackend {
  return { getStatusV2: async () => payload };
}

describe("getSwapStatus mapping", () => {
  const cases: Array<[string, string]> = [
    ["WAITING", "waiting"],
    ["RECEIVING", "receiving"],
    ["SWAPPING", "swapping"],
    ["SENDING", "sending"],
    ["SENT", "sent"],
    ["COMPLETED", "complete"],
    ["FAILED", "failed"],
  ];

  it.each(cases)("maps SDK state %s -> %s", async (sdkState, expected) => {
    const result = await getSwapStatus(backendReturning({ state: sdkState }), "123-Bitcoin-45");
    expect(result.status).toBe(expected);
  });

  it("maps an unknown/missing state to waiting", async () => {
    expect((await getSwapStatus(backendReturning({}), "id")).status).toBe("waiting");
    expect((await getSwapStatus(backendReturning({ state: "MYSTERY" }), "id")).status).toBe(
      "waiting",
    );
  });

  it("passes the deposit channel id through and keeps the raw payload", async () => {
    let seenId = "";
    const backend: StatusBackend = {
      getStatusV2: async ({ id }) => {
        seenId = id;
        return { state: "WAITING" };
      },
    };
    const result = await getSwapStatus(backend, "99-Ethereum-7");
    expect(seenId).toBe("99-Ethereum-7");
    expect(result.raw).toEqual({ state: "WAITING" });
  });

  it("extracts failure/egress substates", async () => {
    const depositFailure = {
      mode: "DEPOSIT_TOO_SMALL",
      reason: { code: "BelowMinimumDeposit", message: "below minimum" },
    };
    const swapEgressFailure = { mode: "EGRESS", reason: { message: "egress failed" } };
    const fallbackEgress = { amount: "5", scheduledAt: 1 };
    const refundEgress = { amount: "7", txRef: "0xdead" };
    const result = await getSwapStatus(
      backendReturning({
        state: "FAILED",
        deposit: { failure: depositFailure },
        swapEgress: { scheduledAt: 2, failure: swapEgressFailure },
        fallbackEgress,
        refundEgress,
      }),
      "id",
    );
    expect(result.depositFailure).toEqual(depositFailure);
    expect(result.swapEgressFailure).toEqual(swapEgressFailure);
    expect(result.egress?.scheduledAt).toBe(2);
    expect(result.fallbackEgress).toEqual(fallbackEgress);
    expect(result.refundEgress).toEqual(refundEgress);
  });
});

describe("progress facts", () => {
  const cases: Array<[string, unknown, ChainflipProgressFacts]> = [
    [
      "a regular swap",
      {
        state: "SWAPPING",
        srcChainRequiredBlockConfirmations: 3,
        estimatedDurationsSeconds: { deposit: 6.65, swap: 12, egress: 96 },
        deposit: { amount: "1", txConfirmations: 2 },
        boost: { maxBoostFeeBps: 5, boostedAt: 1_000 },
        swap: { regular: { scheduledAt: 2_000, latestSwapRescheduledAt: 3_000 } },
        lastStatechainUpdateAt: 3_500,
      },
      {
        depositConfirmations: 2,
        requiredConfirmations: 3,
        boostedAt: 1_000,
        swapScheduledAt: 2_000,
        swapRescheduledAt: 3_000,
        estimatedDurationsSeconds: { deposit: 6.65, swap: 12, egress: 96 },
        lastStatechainUpdateAt: 3_500,
      },
    ],
    [
      "a DCA swap",
      {
        state: "SWAPPING",
        swap: {
          dca: {
            executedChunks: 2,
            remainingChunks: 3,
            currentChunk: { scheduledAt: 4_000, latestSwapRescheduledAt: 5_000 },
          },
        },
      },
      { chunks: { executed: 2, remaining: 3 }, swapRescheduledAt: 5_000 },
    ],
    [
      "a completed swap's estimates",
      { state: "COMPLETED", estimatedDurationsSeconds: { swap: 12, egress: null } },
      { estimatedDurationsSeconds: { swap: 12 } },
    ],
    [
      "malformed fields",
      {
        state: "SWAPPING",
        srcChainRequiredBlockConfirmations: null,
        estimatedDurationsSeconds: { deposit: -1, swap: "12" },
        deposit: { txConfirmations: 1.5 },
        boost: { boostedAt: -1 },
        swap: { regular: "soon", dca: { executedChunks: 2 } },
        lastStatechainUpdateAt: "now",
      },
      {},
    ],
    ["a body that is not an object", [], {}],
  ];

  it.each(cases)("reads %s", async (_, body, expected) => {
    expect((await getSwapStatus(backendReturning(body), "id")).progress).toEqual(expected);
  });
});

describe("isImplicitFailure", () => {
  it("detects a deposit failure while the SDK state is not failed", async () => {
    const result = await getSwapStatus(
      backendReturning({ state: "SWAPPING", deposit: { failure: { mode: "REJECTED" } } }),
      "id",
    );
    expect(result.status).toBe("swapping"); // SDK never flipped to FAILED on its own
    expect(isImplicitFailure(result)).toBe(true);
  });

  it("detects swap-egress failure and fallback egress", async () => {
    const egressFail = await getSwapStatus(
      backendReturning({ state: "SENDING", swapEgress: { failure: { mode: "X" } } }),
      "id",
    );
    expect(isImplicitFailure(egressFail)).toBe(true);

    const fallback = await getSwapStatus(
      backendReturning({ state: "SENDING", fallbackEgress: { amount: "5" } }),
      "id",
    );
    expect(isImplicitFailure(fallback)).toBe(true);
  });

  it("is false on a clean status and on a refund-only (explicit-failure) status", async () => {
    const clean = await getSwapStatus(backendReturning({ state: "SWAPPING" }), "id");
    expect(isImplicitFailure(clean)).toBe(false);

    // refundEgress accompanies an explicit top-level FAILED, not an implicit substate
    const refunded = await getSwapStatus(
      backendReturning({ state: "FAILED", refundEgress: { amount: "1" } }),
      "id",
    );
    expect(isImplicitFailure(refunded)).toBe(false);
  });
});
