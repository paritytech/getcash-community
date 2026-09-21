// The fetch-backed status read: the right URL, the shared mapping, and a refusal on anything but
// a 2xx.

import { describe, expect, it } from "vitest";
import { readSwapStatus, type FetchLike } from "./swap-status";

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
