// The deposit QR carries a payment URI only where a wallet can act on one: a Chainflip source whose
// chain has a scheme, and the channel's exact figure. Everything else is the bare address, which is
// what the copy row carries in every case.

import { describe, expect, it } from "vitest";
import { depositQrValue } from "../app/funding/deposit-qr";

const exact = (sourceId: string, address: string, amount: string) =>
  depositQrValue({ sourceId, address, amount, exact: true });

describe("depositQrValue", () => {
  it("encodes the chain's payment URI for a native coin with the channel's exact amount", () => {
    expect(exact("btc", "bc1qdeposit", "250000")).toBe("bitcoin:bc1qdeposit?amount=0.0025");
    expect(exact("eth", "0xabc", "110000000000000000")).toBe(
      "ethereum:0xabc@1?value=110000000000000000",
    );
    expect(exact("sol-solana", "SoLDeposit", "3000000000")).toBe("solana:SoLDeposit?amount=3");
  });

  it("encodes the token transfer form for a token the chain has a scheme for, and the bare address where it has none", () => {
    expect(exact("usdc-eth", "0xabc", "250000000")).toBe(
      "ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=0xabc&uint256=250000000",
    );
    expect(exact("usdt-tron", "TDeposit", "250000000")).toBe("TDeposit");
  });

  it("keeps the bare address when the figure is only an estimate", () => {
    expect(
      depositQrValue({ sourceId: "btc", address: "bc1q", amount: "250000", exact: false }),
    ).toBe("bc1q");
  });

  it("keeps the bare address for a deposit straight to the request's account, and for a source it does not know", () => {
    expect(exact("dot-assethub", "5Burner", "30000000000")).toBe("5Burner");
    expect(exact("usdc-assethub", "5Burner", "10000000")).toBe("5Burner");
    expect(exact("meld-card", "5Burner", "10000000")).toBe("5Burner");
    expect(exact("nope", "5Burner", "10000000")).toBe("5Burner");
  });

  it("keeps the bare address for a figure it cannot read, or nothing to send", () => {
    expect(exact("btc", "bc1q", "abc")).toBe("bc1q");
    expect(exact("btc", "bc1q", "0")).toBe("bc1q");
    expect(exact("btc", "", "250000")).toBe("");
  });
});
