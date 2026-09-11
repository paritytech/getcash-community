import { describe, expect, it } from "vitest";
import { recoveryNotes, refundedFailure, refundStatusTail } from "../app/utils/recovery";

describe("refundedFailure", () => {
  it("names the two failures whose funds come back to the refund key", () => {
    expect(refundedFailure("refunded")).toBe(true);
    expect(refundedFailure("refund-failed")).toBe(true);
    for (const kind of ["mint", "under-credit", "deposit-rejected", "expired", "unknown"]) {
      expect(refundedFailure(kind)).toBe(false);
    }
  });
});

describe("recoveryNotes", () => {
  it("names the secret the way the chain's wallets do", () => {
    expect(recoveryNotes("Bitcoin", "BTC", "wif").secretLabel).toBe("Private key (WIF)");
    expect(recoveryNotes("Ethereum", "ETH", "hex").secretLabel).toBe("Private key");
    expect(recoveryNotes("Tron", "TRX", "hex").secretLabel).toBe("Private key");
    expect(recoveryNotes("Solana", "SOL", "base58").secretLabel).toBe("Secret key");
  });

  it("labels an unrevealed secret a private key", () => {
    expect(recoveryNotes("Tron", "USDT").secretLabel).toBe("Private key");
  });

  it("has no gas step for a refund in the chain's own coin", () => {
    expect(recoveryNotes("Bitcoin", "BTC").gasNote).toBeNull();
    expect(recoveryNotes("Arbitrum", "ETH").gasNote).toBeNull();
    expect(recoveryNotes("Solana", "SOL").gasNote).toBeNull();
  });

  it("tells a token refund which coin it needs for fees, with Tron's design-given amount", () => {
    expect(recoveryNotes("Tron", "USDT").gasNote).toBe(
      "USDT on Tron can't move without TRX. Send a small amount to this address first, " +
        "around 15 TRX is enough. If you don't have TRX, you can buy it on any exchange.",
    );
    expect(recoveryNotes("Solana", "USDC").gasNote).toContain("can't move without SOL");
    expect(recoveryNotes("Solana", "USDC").gasNote).not.toContain("is enough");
    expect(recoveryNotes("Arbitrum", "USDC").gasNote).toContain("can't move without ETH");
  });

  it("walks the key into a wallet on the refund's chain", () => {
    const notes = recoveryNotes("Tron", "USDT");
    expect(notes.importNote).toBe("Import this key into any wallet that supports Tron.");
    expect(notes.transferNote).toBe("Transfer your USDT to any Tron address you control");
  });
});

describe("refundStatusTail", () => {
  it("shortens the transaction of a refund on its way", () => {
    expect(refundStatusTail({ txRef: "7f1c9b2e4d6a8c0f1e3b5d7a9c2e4f6081a3c5e7" })).toBe(
      "is on its way back, transaction 7f1c9b…3c5e7",
    );
  });

  it("prefers the landing over the transaction once witnessed", () => {
    expect(refundStatusTail({ txRef: "x".repeat(40), witnessedAt: 1 })).toBe(
      "is back at your recovery address.",
    );
  });

  it("promises the return before anything has been seen", () => {
    expect(refundStatusTail(undefined)).toBe("is being returned to your recovery address.");
    expect(refundStatusTail({})).toBe("is being returned to your recovery address.");
  });
});
