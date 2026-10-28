// A channel's expiry block timed at the pace a scripted state chain tracked the source chain.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chainflipRpc,
  chainPace,
  channelExpiresAt as atPace,
  PACE_WINDOW_BLOCKS,
  type ChainflipRpc,
} from "./channel-expiry";

const BEST = 13_653_793;
const NOW = 1_793_007_348_000;

const channelExpiresAt = async (rpc: ChainflipRpc, chain: string, expiryBlock: bigint) =>
  atPace(await chainPace(rpc, chain), expiryBlock);

const u64 = (n: number) =>
  `0x${BigInt(n).toString(16).padStart(16, "0").match(/../g)!.reverse().join("")}`;

/** A state chain whose replies at its best block and at the window's start are `now` and `then`. */
function chain(
  now: { heights: unknown; at: unknown },
  then: { heights: unknown; at: unknown },
): { rpc: ChainflipRpc; asked: string[] } {
  const asked: string[] = [];
  const reply = (hash: unknown) => (hash === `0x${BEST}` ? now : then);
  const rpc: ChainflipRpc = async (method, params) => {
    asked.push(method);
    switch (method) {
      case "chain_getHeader":
        return { number: `0x${BEST.toString(16)}` };
      case "chain_getBlockHash":
        return `0x${String(params[0])}`;
      case "cf_monitoring_external_chains_block_height":
        return reply(params[0]).heights;
      case "state_getStorage":
        return reply(params[1]).at;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, asked };
}

describe("a channel's expiry", () => {
  it("times the expiry block at the pace Chainflip tracked the chain", async () => {
    // 300 Asset Hub blocks in 3600 s, 12 s a block
    const { rpc } = chain(
      { heights: { assethub: 4_161_549, bitcoin: 5_218_290 }, at: u64(NOW) },
      { heights: { assethub: 4_161_249, bitcoin: 5_218_123 }, at: u64(NOW - 3_600_000) },
    );
    expect(await channelExpiresAt(rpc, "Assethub", 4_162_149n)).toBe(NOW + 600 * 12_000);
  });

  it("measures across the window's Chainflip blocks", async () => {
    const hashes: unknown[] = [];
    const { rpc } = chain(
      { heights: { assethub: 2 }, at: u64(NOW) },
      { heights: { assethub: 1 }, at: u64(NOW - 2_000) },
    );
    const spy: ChainflipRpc = (method, params) => {
      if (method === "chain_getBlockHash") hashes.push(params[0]);
      return rpc(method, params);
    };
    await channelExpiresAt(spy, "Assethub", 10n);
    expect(hashes.sort()).toEqual([BEST - PACE_WINDOW_BLOCKS, BEST]);
  });

  // Perseverance steps 3 blocks at 12 s, mainnet up to 12 at 2 s
  it.each([
    ["Perseverance", 12_000, 3, 600],
    ["mainnet", 2_000, 12, 43_200],
  ] as const)(
    "keeps %s's tracking steps to about 1%% of the time left",
    async (_, ms, step, left) => {
      const blocks = (PACE_WINDOW_BLOCKS * 6_000) / ms;
      // The worst phase: the window's end read a whole step behind
      const { rpc } = chain(
        { heights: { assethub: 1_000_000 + blocks - step }, at: u64(NOW) },
        { heights: { assethub: 1_000_000 }, at: u64(NOW - PACE_WINDOW_BLOCKS * 6_000) },
      );
      const expiry = BigInt(1_000_000 + blocks - step + left);
      const off = (await channelExpiresAt(rpc, "Assethub", expiry)) - NOW - left * ms;
      expect(Math.abs(off) / (left * ms)).toBeLessThan(0.011);
    },
  );

  it("puts a block already passed in the past", async () => {
    const { rpc } = chain(
      { heights: { assethub: 100 }, at: u64(NOW) },
      { heights: { assethub: 50 }, at: u64(NOW - 100_000) },
    );
    expect(await channelExpiresAt(rpc, "Assethub", 90n)).toBe(NOW - 20_000);
  });

  it("refuses a chain Chainflip has not tracked lately, or does not track", async () => {
    const stalled = chain(
      { heights: { assethub: 7 }, at: u64(NOW) },
      { heights: { assethub: 7 }, at: u64(NOW - 1) },
    );
    await expect(channelExpiresAt(stalled.rpc, "Assethub", 10n)).rejects.toThrow(/not tracked/);
    const untracked = chain(
      { heights: { bitcoin: 7 }, at: u64(NOW) },
      { heights: { bitcoin: 6 }, at: u64(NOW - 1) },
    );
    await expect(channelExpiresAt(untracked.rpc, "Assethub", 10n)).rejects.toThrow(/no Assethub/);
  });

  it("refuses a timestamp it cannot read", async () => {
    const { rpc } = chain(
      { heights: { assethub: 2 }, at: null },
      { heights: { assethub: 1 }, at: u64(NOW) },
    );
    await expect(channelExpiresAt(rpc, "Assethub", 10n)).rejects.toThrow(/no timestamp/);
  });
});

describe("the state chain RPC", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gives up on a call that never answers, so the channel open fails instead of hanging", async () => {
    const timeout = new AbortController();
    const bound = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
    const call = chainflipRpc("perseverance")("chain_getHeader", []);
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    await expect(call).rejects.toThrow(/timed out/);
    expect(bound).toHaveBeenCalledWith(10_000);
  });
});
