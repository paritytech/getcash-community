// Where a refund transaction can be watched, per chain.

import { describe, expect, it } from "vitest";
import { REFUND_CHAINS } from "@getsome/ephemeral";
import { refundTxUrl } from "../app/utils/explorer";

describe("refund transaction links", () => {
  it("covers every chain a refund can land on", () => {
    // A chain added to the refund set without an explorer would silently drop the link.
    for (const chain of REFUND_CHAINS) {
      expect(refundTxUrl(chain, "abc123"), chain).toContain("abc123");
    }
  });

  it("sends each EVM chain to its own explorer", () => {
    expect(refundTxUrl("Ethereum", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(refundTxUrl("Arbitrum", "0xabc")).toBe("https://arbiscan.io/tx/0xabc");
    expect(refundTxUrl("Bsc", "0xabc")).toBe("https://bscscan.com/tx/0xabc");
  });

  it("escapes the reference into the URL", () => {
    expect(refundTxUrl("Bitcoin", "a/b?c")).toBe("https://mempool.space/tx/a%2Fb%3Fc");
  });

  it("has nothing to link without a chain or a transaction", () => {
    expect(refundTxUrl(null, "abc")).toBeNull();
    expect(refundTxUrl("Bitcoin", undefined)).toBeNull();
    expect(refundTxUrl("Bitcoin", "")).toBeNull();
  });
});
