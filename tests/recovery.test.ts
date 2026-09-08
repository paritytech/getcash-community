import { describe, expect, it } from "vitest";
import type { RefundKey } from "@getsome/ephemeral";
import { recoveryNotes, refundedFailure } from "../app/utils/recovery";

const key = (chain: RefundKey["chain"], format: RefundKey["format"]): RefundKey => ({
  chain,
  format,
  address: "a",
  secret: "s",
});

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
    expect(recoveryNotes(key("Bitcoin", "wif"), "BTC").secretLabel).toBe("Private key (WIF)");
    expect(recoveryNotes(key("Ethereum", "hex"), "ETH").secretLabel).toBe("Private key");
    expect(recoveryNotes(key("Tron", "hex"), "TRX").secretLabel).toBe("Private key");
    expect(recoveryNotes(key("Solana", "base58"), "SOL").secretLabel).toBe("Secret key");
  });

  it("has nothing to add for a refund in the chain's own coin", () => {
    expect(recoveryNotes(key("Bitcoin", "wif"), "BTC").gasNote).toBeNull();
    expect(recoveryNotes(key("Arbitrum", "hex"), "ETH").gasNote).toBeNull();
    expect(recoveryNotes(key("Solana", "base58"), "SOL").gasNote).toBeNull();
  });

  it("tells a token refund which coin it needs for fees", () => {
    expect(recoveryNotes(key("Tron", "hex"), "USDT").gasNote).toBe(
      "USDT on Tron needs TRX in this address to move. Send a little TRX there first.",
    );
    expect(recoveryNotes(key("Solana", "base58"), "USDC").gasNote).toContain("needs SOL");
    expect(recoveryNotes(key("Arbitrum", "hex"), "USDC").gasNote).toContain("needs ETH");
  });
});
