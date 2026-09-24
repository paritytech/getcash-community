// The fetch-backed status read: the right URL, the shared mapping, and a refusal on anything but
// a 2xx.

import { describe, expect, it } from "vitest";
import { readChannelRecord, readSwapStatus, type FetchLike } from "./swap-status";

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
