import { describe, expect, it } from "vitest";
import type { MeldClientLike } from "./client";
import { getMeldStatus } from "./status";

function clientReturning(
  status: string,
  extra?: { providerStatus?: string; sourceAmount?: string; fiat?: string },
): MeldClientLike {
  return {
    getQuote: async () => ({ quotes: [] }),
    createSession: async () => ({
      fundingRequestId: "funding-1",
      sessionId: "s",
      externalSessionId: "ext",
      widgetUrl: "u",
    }),
    getStatus: async () => ({ status, ...extra }),
    cancel: async () => ({ outcome: "cancelled" as const }),
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
      "declined",
      "Your bank declined the payment. Check your card details or try another card.",
      "deposit-rejected",
    ],
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

  // The adapter has no `refunded` state: its rail maps REFUNDED onto `failed` and sends the
  // provider's own string alongside. These assert the ending is read from there.
  it("reads a refund off the provider status and names the returned amount", async () => {
    // Money was captured and returned: the message must not claim nothing was taken.
    const result = await getMeldStatus(
      clientReturning("failed", { providerStatus: "REFUNDED", sourceAmount: "50.10", fiat: "EUR" }),
      "funding-1",
    );

    expect(result.status).toBe("failed");
    expect(result.depositFailure?.reason?.code).toBe("refunded");
    expect(result.depositFailure?.reason?.message).toBe(
      "Your top-up didn't go through. Your 50.10 EUR has been returned to your card.",
    );
    expect(result.depositFailure?.kind).toBe("deposit-rejected");
    // `raw` carries the provider status, so a refund is distinguishable downstream.
    expect(result.raw).toBe("REFUNDED");
  });

  it("falls back to the plain returned-money message when no terms are reported", async () => {
    const result = await getMeldStatus(
      clientReturning("failed", { providerStatus: "REFUNDED" }),
      "funding-1",
    );

    expect(result.depositFailure?.reason?.message).toBe(
      "Your top-up didn't go through. Your money has been returned to your card.",
    );
  });

  it("reads a bank decline off the provider status", async () => {
    const result = await getMeldStatus(
      clientReturning("failed", { providerStatus: "DECLINED" }),
      "funding-1",
    );

    expect(result.depositFailure?.reason?.code).toBe("declined");
    expect(result.depositFailure?.reason?.message).toMatch(/bank declined/i);
  });

  it.each(["CANCELLED", "CANCELED"])("reads a cancel off the provider status (%s)", async (s) => {
    // No money moved, so it reads as the plain failure does.
    const result = await getMeldStatus(clientReturning("failed", { providerStatus: s }), "f-1");

    expect(result.depositFailure?.reason?.code).toBe("cancelled");
    expect(result.depositFailure?.reason?.message).toBe("Top-up didn't go through. No money was taken.");
  });

  it("keeps the coarse wording for a provider ending it does not know", async () => {
    const result = await getMeldStatus(
      clientReturning("failed", { providerStatus: "SOME_NEW_ENDING" }),
      "funding-1",
    );

    expect(result.depositFailure?.reason?.code).toBe("failed");
    expect(result.depositFailure?.reason?.message).toBe("Top-up didn't go through. No money was taken.");
  });

  it("keeps a plain decline as a failure, not a refund", async () => {
    const result = await getMeldStatus(clientReturning("failed"), "funding-1");
    expect(result.depositFailure?.reason?.code).toBe("failed");
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
