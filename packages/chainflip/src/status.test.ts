import { describe, expect, it } from "vitest";
import {
  CHAINFLIP_PROGRESS_STATUSES,
  getSwapStatus,
  isImplicitFailure,
  type StatusBackend,
} from "./status";

function backendReturning(payload: unknown): StatusBackend {
  return { getStatusV2: async () => payload };
}

describe("getSwapStatus mapping", () => {
  const cases: Array<[string, string]> = [
    ["WAITING", "waiting"],
    ["RECEIVING", "receiving"],
    ["SWAPPING", "swapping"],
    ["SENDING", "sending"],
    ["SENT", "sending"], // SENT collapses into 'sending'
    ["COMPLETED", "complete"],
    ["FAILED", "failed"],
  ];

  it.each(cases)("maps SDK state %s -> %s", async (sdkState, expected) => {
    const result = await getSwapStatus(backendReturning({ state: sdkState }), "123-Bitcoin-45");
    expect(result.status).toBe(expected);
  });

  it("exports the ordered progress vocabulary", () => {
    expect(CHAINFLIP_PROGRESS_STATUSES).toEqual([
      "waiting",
      "receiving",
      "swapping",
      "sending",
      "complete",
    ]);
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
    const depositFailure = { mode: "DEPOSIT_TOO_SMALL", reason: { message: "below minimum" } };
    const swapEgressFailure = { mode: "EGRESS", reason: { message: "egress failed" } };
    const fallbackEgress = { amount: "5", scheduledAt: 1 };
    const refundEgress = { amount: "7", txRef: "0xdead" };
    const result = await getSwapStatus(
      backendReturning({
        state: "FAILED",
        deposit: { failure: depositFailure },
        swapEgress: { failure: swapEgressFailure },
        fallbackEgress,
        refundEgress,
      }),
      "id",
    );
    expect(result.depositFailure).toEqual(depositFailure);
    expect(result.swapEgressFailure).toEqual(swapEgressFailure);
    expect(result.fallbackEgress).toEqual(fallbackEgress);
    expect(result.refundEgress).toEqual(refundEgress);
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
