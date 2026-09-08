import { describe, expect, it } from "vitest";
import type { MeldClientLike } from "./client";
import { getMeldStatus } from "./status";

function clientReturning(status: string): MeldClientLike {
  return {
    getQuote: async () => ({ quotes: [] }),
    createSession: async () => ({
      fundingRequestId: "funding-1",
      sessionId: "s",
      externalSessionId: "ext",
      widgetUrl: "u",
    }),
    getStatus: async () => ({ status }),
  };
}

describe("getMeldStatus", () => {
  it("maps settled to complete", async () => {
    expect((await getMeldStatus(clientReturning("settled"), "funding-1")).status).toBe("complete");
  });

  it("maps transaction_seen to receiving", async () => {
    // The adapter has a transaction against this request but it has not concluded.
    expect((await getMeldStatus(clientReturning("transaction_seen"), "funding-1")).status).toBe(
      "receiving",
    );
  });

  it("keeps the pre-payment states at waiting", async () => {
    expect((await getMeldStatus(clientReturning("created"), "funding-1")).status).toBe("waiting");
    expect((await getMeldStatus(clientReturning("session_opened"), "funding-1")).status).toBe(
      "waiting",
    );
  });

  it("does not guess a terminal state from a status it does not know", async () => {
    // An unknown state reads as waiting.
    expect((await getMeldStatus(clientReturning("some_new_state"), "funding-1")).status).toBe(
      "waiting",
    );
    expect((await getMeldStatus(clientReturning(""), "funding-1")).status).toBe("waiting");
  });

  it.each([
    ["failed", "Top-up didn't go through. No money was taken.", "deposit-rejected"],
    ["expired", "The payment window closed before the payment arrived.", "expired"],
    ["refused", "The payment was declined before it started.", "deposit-rejected"],
    [
      "unobserved",
      "We could not confirm this payment. Contact support before trying again.",
      "unknown",
    ],
  ])("maps %s to failed with a reason that says which", async (status, message, kind) => {
    // Each failure state has its own message and kind.
    const result = await getMeldStatus(clientReturning(status), "funding-1");

    expect(result.status).toBe("failed");
    expect(result.depositFailure?.reason?.code).toBe(status);
    expect(result.depositFailure?.reason?.message).toBe(message);
    expect(result.depositFailure?.kind).toBe(kind);
  });

  // The poll reads `raw` to decide the payment has started.
  it("passes the adapter's status through as `raw`", async () => {
    expect((await getMeldStatus(clientReturning("session_opened"), "funding-1")).raw).toBe(
      "session_opened",
    );
    expect((await getMeldStatus(clientReturning("transaction_seen"), "funding-1")).raw).toBe(
      "transaction_seen",
    );
    expect((await getMeldStatus(clientReturning("settled"), "funding-1")).raw).toBe("settled");
  });
});
