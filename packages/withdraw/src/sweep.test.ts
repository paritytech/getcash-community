// The sweep over a scripted Asset Hub: one transfer of everything, the attempt persisted before
// it leaves, a lost answer read back from the empty key, and rejections counted to the bound.

import { describe, expect, it } from "vitest";
import { freshSweepState, sweepOnce, type SweepInput } from "./sweep";
import { MAX_REJECTIONS, WithdrawRejectedError } from "./tick";

const CHANNEL = "5Channel";
const SIGNER = {} as never;

type Submit = { args: unknown; options: unknown };
type Outcome = { ok: true } | { ok: false; error: string };

/** An Asset Hub whose key balances come from a script and whose submits answer from another. */
function world(balances: bigint[], outcomes: Outcome[], overrides: Partial<SweepInput> = {}) {
  const submits: Submit[] = [];
  const events: string[] = [];
  const api = {
    tx: {
      Balances: {
        transfer_all: (args: unknown) => ({
          signAndSubmit: async (_signer: unknown, options: unknown) => {
            submits.push({ args, options });
            events.push("submit");
            const outcome = outcomes.shift() ?? { ok: true };
            return outcome.ok
              ? { ok: true, txHash: `0x${submits.length}`, block: { number: 100 + submits.length } }
              : {
                  ok: false,
                  txHash: `0x${submits.length}`,
                  dispatchError: {
                    type: "Module",
                    value: { type: "Balances", value: { type: outcome.error } },
                  },
                };
          },
        }),
      },
    },
  } as unknown as SweepInput["assetHubApi"];
  const txs: { call: string; txHash: string; block?: number }[] = [];
  const input: SweepInput = {
    assetHubApi: api,
    key: { signer: SIGNER },
    to: CHANNEL,
    tickTimeoutMs: 1_000,
    submitTimeoutMs: 1_000,
    signOptions: { at: "0xbest" },
    readKeyOnAssetHub: async () => balances.shift() ?? 0n,
    onBeforeSubmit: () => {
      events.push("persist");
    },
    onTx: (info) => txs.push(info),
    ...overrides,
  };
  return { input, submits, events, txs };
}

describe("the sweep", () => {
  it("moves everything to the channel in one transfer, persisted before it leaves", async () => {
    const { input, submits, events, txs } = world([7_000_000_000n], []);
    const state = freshSweepState();
    await sweepOnce(input, state);
    expect(submits).toEqual([
      {
        args: { dest: { type: "Id", value: CHANNEL }, keep_alive: false },
        options: { at: "0xbest" },
      },
    ]);
    expect(events).toEqual(["persist", "submit"]);
    expect(txs).toEqual([{ call: "sweep", txHash: "0x1", block: 101 }]);
    expect(state).toEqual({ attempts: 1, rejections: 0 });
  });

  it("counts the attempt before the driver persists it, so a dead worker still reads it back", async () => {
    const state = freshSweepState();
    const seen: number[] = [];
    const { input } = world([5n], [], {
      onBeforeSubmit: () => {
        seen.push(state.attempts);
      },
    });
    await sweepOnce(input, state);
    expect(seen).toEqual([1]);
  });

  it("takes an empty key after a submit as done, without submitting again", async () => {
    const { input, submits } = world([0n], []);
    await sweepOnce(input, { attempts: 1, rejections: 0 });
    expect(submits).toEqual([]);
  });

  it("refuses an empty key before any submit: there is nothing to move", async () => {
    const { input, submits } = world([0n], []);
    await expect(sweepOnce(input, freshSweepState())).rejects.toThrow("nothing on the key");
    expect(submits).toEqual([]);
  });

  it("counts a rejection and gives up on the third", async () => {
    const rejected = { ok: false as const, error: "InsufficientBalance" };
    const { input } = world([5n, 5n, 5n], [rejected, rejected, rejected]);
    const state = freshSweepState();
    await expect(sweepOnce(input, state)).rejects.toThrow(/sweep rejected/);
    await expect(sweepOnce(input, state)).rejects.toThrow(/sweep rejected/);
    const last = await sweepOnce(input, state).catch((e: unknown) => e);
    expect(last).toBeInstanceOf(WithdrawRejectedError);
    expect((last as WithdrawRejectedError).call).toBe("sweep");
    expect(state).toEqual({ attempts: MAX_REJECTIONS, rejections: MAX_REJECTIONS });
  });

  it("bounds a balance read that never answers", async () => {
    const { input } = world([], [], {
      readKeyOnAssetHub: () => new Promise(() => {}),
      tickTimeoutMs: 5,
    });
    await expect(sweepOnce(input, freshSweepState())).rejects.toThrow(/timed out/);
  });
});
