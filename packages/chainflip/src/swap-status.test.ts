// The fetch-backed status read: the right URL, the shared mapping, and a refusal on anything but
// a 2xx.

import { describe, expect, it } from "vitest";
import {
  channelTermsFault,
  readChannelRecord,
  readSwapStatus,
  type ChainflipChannelRecord,
  type FetchLike,
} from "./swap-status";

function answering(status: number, body: unknown) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, urls };
}

describe("reading a swap's status with fetch", () => {
  it("asks Chainflip's API for the channel and maps the answer", async () => {
    const { fetchImpl, urls } = answering(200, { state: "SENDING", swapEgress: { amount: "9" } });
    const reading = await readSwapStatus("42", fetchImpl);
    expect(urls).toEqual(["https://chainflip-swap.chainflip.io/v2/swaps/42"]);
    expect(reading.status).toBe("sending");
    expect(reading.egress?.amount).toBe("9");
  });

  it("throws on a failed request rather than reading a status into it", async () => {
    const { fetchImpl } = answering(503, { message: "down" });
    await expect(readSwapStatus("42", fetchImpl)).rejects.toThrow("HTTP 503");
  });
});

describe("the channel record read", () => {
  const record = {
    destAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    destChain: "Bitcoin",
    destAsset: "BTC",
    srcChain: "Assethub",
    srcAsset: "DOT",
    brokers: [{ commissionBps: 5 }, { commissionBps: 2 }],
    fillOrKillParams: { refundAddress: "5Key", minPrice: "0.99" },
    depositChannel: { depositAddress: "5Channel", isExpired: false },
  };
  const serving =
    (body: unknown, status = 200): FetchLike =>
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

  it("reads back what the provider has for the channel", async () => {
    expect(await readChannelRecord("42", serving(record))).toEqual({
      depositAddress: "5Channel",
      destinationAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      destinationChain: "Bitcoin",
      destinationAsset: "BTC",
      refundAddress: "5Key",
      sourceChain: "Assethub",
      sourceAsset: "DOT",
      commissionBps: 7,
      minPrice: 0.99,
      expired: false,
    });
  });

  it("answers null for a channel the provider answers about but cannot name", async () => {
    expect(await readChannelRecord("42", serving({ destAddress: "bc1q" }))).toBeNull();
    expect(
      await readChannelRecord("42", serving({ ...record, depositChannel: { isExpired: true } })),
    ).toBeNull();
  });

  it("throws on a not-found, since a fresh channel may not be indexed yet", async () => {
    // Both refuse to pay; a throw retries on the next tick rather than burning the job on a race.
    await expect(readChannelRecord("42", serving({}, 404))).rejects.toThrow(/HTTP 404/);
  });

  it("carries the provider's own word that the channel is closed", async () => {
    const closed = { ...record, depositChannel: { depositAddress: "5Channel", isExpired: true } };
    expect((await readChannelRecord("42", serving(closed)))?.expired).toBe(true);
  });

  it("throws on a read that failed, so the tick retries rather than paying unchecked", async () => {
    await expect(readChannelRecord("42", serving({}, 503))).rejects.toThrow(/HTTP 503/);
  });
});

describe("a channel's minimum price against the one asked for", () => {
  const usdt = { chain: "Assethub", asset: "USDT" };
  const served = (minPrice: number, chain: string, asset: string) =>
    ({
      sourceChain: "Assethub",
      sourceAsset: "USDT",
      destinationChain: chain,
      destinationAsset: asset,
      commissionBps: 5,
      minPrice,
    }) as ChainflipChannelRecord;

  it("allows for the rounding to the paid asset's decimals, and no more", () => {
    const asked = 0.0000154849;
    expect(channelTermsFault(served(0.00001548, "Bitcoin", "BTC"), usdt, asked)).toBeNull();
    expect(channelTermsFault(served(0.00001547, "Bitcoin", "BTC"), usdt, asked)).toMatch(
      /minimum price is 0.00001547/,
    );
    expect(channelTermsFault(served(0.9946, "Ethereum", "USDC"), usdt, 0.9948)).toMatch(
      /minimum price is 0.9946/,
    );
  });
});
