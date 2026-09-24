// The deposit pickers' grouping and the line under a greyed row.

import { describe, expect, it } from "vitest";
import {
  groupNetworks,
  groupTokens,
  networkSubtitle,
  smallestMinimumCash,
  tokenSubtitle,
  wholeCashCeil,
} from "../app/funding/source-groups";
import type { NetworkRow, TokenOffer, TokenRow } from "../app/stores/offers";

const token = (asset: string, offer: TokenOffer): TokenRow => ({
  asset,
  sourceId: asset.toLowerCase() as TokenRow["sourceId"],
  offer,
});

const network = (label: string, tokens: TokenRow[]): NetworkRow => {
  const available = tokens.some(
    (t) => t.offer.state === "available" || t.offer.state === "ungated",
  );
  return {
    chain: label,
    label,
    tokens,
    available,
    checking: !available && tokens.some((t) => t.offer.state === "checking"),
  };
};

describe("source groups", () => {
  it("rounds a minimum up to whole CASH", () => {
    expect(wholeCashCeil(80_000_000n)).toBe("80");
    expect(wholeCashCeil(80_000_001n)).toBe("81");
    expect(smallestMinimumCash([])).toBeNull();
    expect(
      smallestMinimumCash([
        token("A", { state: "too-small", minimumCashBase: 90_000_000n }),
        token("B", { state: "too-small", minimumCashBase: 80_000_000n }),
        token("C", { state: "too-small", minimumCashBase: null }),
      ]),
    ).toBe(80_000_000n);
  });

  it("says why a token cannot be picked, and nothing when it can", () => {
    expect(tokenSubtitle({ state: "too-small", minimumCashBase: 80_000_000n })).toBe(
      "Minimum for this token is $80 CASH",
    );
    expect(tokenSubtitle({ state: "too-small", minimumCashBase: null })).toBe("Amount too small");
    expect(tokenSubtitle({ state: "rail-off" })).toBe("Not available yet");
    expect(tokenSubtitle({ state: "unavailable", reason: "maintenance" })).toBe(
      "Not available right now",
    );
    expect(tokenSubtitle({ state: "checking" })).toBe("Checking…");
    expect(tokenSubtitle({ state: "ungated" })).toBeUndefined();
  });

  it("names a network's smallest minimum, or why none of its tokens answer", () => {
    const tooSmall = network("Bitcoin", [
      token("BTC", { state: "too-small", minimumCashBase: 80_000_000n }),
    ]);
    expect(networkSubtitle(tooSmall)).toBe("Minimum for this network is $80 CASH");
    const off = network("Tron", [token("TRX", { state: "rail-off" })]);
    expect(networkSubtitle(off)).toBe("Not available yet");
    const down = network("Solana", [token("SOL", { state: "unavailable", reason: "down" })]);
    expect(networkSubtitle(down)).toBe("Not available right now");
    const fine = network("Ethereum", [token("ETH", { state: "ungated" })]);
    expect(networkSubtitle(fine)).toBeUndefined();
  });

  it("splits into the pickable group and the greyed one, dropping an empty group", () => {
    const eth = network("Ethereum", [token("ETH", { state: "ungated" })]);
    const btc = network("Bitcoin", [
      token("BTC", { state: "too-small", minimumCashBase: 80_000_000n }),
    ]);
    const pending = network("Solana", [token("SOL", { state: "checking" })]);
    expect(groupNetworks([btc, eth, pending])).toEqual([
      { label: "All networks", rows: [eth, pending] },
      { label: "Unsupported network", rows: [btc] },
    ]);
    expect(groupNetworks([eth])).toEqual([{ label: "All networks", rows: [eth] }]);
    expect(groupNetworks([btc])).toEqual([{ label: "Unsupported network", rows: [btc] }]);
  });

  it("groups tokens the same way", () => {
    const usdt = token("USDT", { state: "ungated" });
    const usdc = token("USDC", { state: "unavailable", reason: "down" });
    expect(groupTokens([usdc, usdt])).toEqual([
      { label: "All tokens", rows: [usdt] },
      { label: "Unsupported token", rows: [usdc] },
    ]);
  });
});
