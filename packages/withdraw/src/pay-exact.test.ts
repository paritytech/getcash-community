// The exact payment over a scripted Asset Hub: one transfer of the quoted figure at the key's
// nonce, persisted before it leaves; a lost answer read back from the nonce and the balance; the
// cases the chain cannot decide stopping instead of paying again; refusals moving the nonce on.

import { describe, expect, it } from "vitest";
import {
  exactPaymentFloor,
  exactPaymentLanded,
  freshExactPayState,
  payExactOnce,
  PaymentUnresolvedError,
  type ExactPayInput,
} from "./pay-exact";
import { MAX_REJECTIONS, WithdrawRejectedError } from "./tick";

const DEPOSIT = "5Deposit";
const KEY = "5Key";
const AMOUNT = 20_000_000_000n;
const SIGNER = {} as never;

type Outcome = { ok: true } | { ok: false; error: string };
type Reading = { free: bigint; nonce: number };

/** An Asset Hub whose key readings come from one script, dry runs from another, and submits
 *  answer from a third. */
function world(
  readings: Reading[],
  outcomes: Outcome[] = [],
  opts: { dryRunFails?: string; overrides?: Partial<ExactPayInput> } = {},
) {
  const submits: { args: unknown; options: unknown }[] = [];
  const events: string[] = [];
  const api = {
    tx: {
      Balances: {
        transfer_keep_alive: (args: unknown) => ({
          decodedCall: { transfer: args },
          getEstimatedFees: async () => 1_000_000n,
          signAndSubmit: async (_signer: unknown, options: unknown) => {
            submits.push({ args, options });
            events.push("submit");
            const outcome = outcomes.shift() ?? { ok: true };
            return outcome.ok
              ? { ok: true, txHash: `0x${submits.length}`, block: { number: 200 + submits.length } }
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
    apis: {
      DryRunApi: {
        dry_run_call: async () =>
          opts.dryRunFails === undefined
            ? { success: true, value: { execution_result: { success: true } } }
            : {
                success: true,
                value: {
                  execution_result: {
                    success: false,
                    value: {
                      error: {
                        type: "Module",
                        value: { type: "Balances", value: { type: opts.dryRunFails } },
                      },
                    },
                  },
                },
              },
      },
    },
    constants: { Balances: { ExistentialDeposit: async () => 100_000_000n } },
  } as unknown as ExactPayInput["assetHubApi"];
  const txs: { call: string; txHash: string; block?: number }[] = [];
  const input: ExactPayInput = {
    assetHubApi: api,
    key: { address: KEY, signer: SIGNER },
    to: DEPOSIT,
    amount: AMOUNT,
    tickTimeoutMs: 1_000,
    submitTimeoutMs: 1_000,
    signOptions: { at: "0xbest" },
    readKey: async () => readings.shift() ?? { free: 0n, nonce: 0 },
    onBeforeSubmit: () => {
      events.push("persist");
    },
    onTx: (info) => txs.push(info),
    ...opts.overrides,
  };
  return { input, submits, events, txs };
}

describe("the exact payment", () => {
  it("pays exactly the quoted figure at the key's nonce, persisted before it leaves", async () => {
    const { input, submits, events, txs } = world([{ free: 21_000_000_000n, nonce: 0 }]);
    const state = freshExactPayState();
    await payExactOnce(input, state);
    expect(submits).toEqual([
      {
        args: { dest: { type: "Id", value: DEPOSIT }, value: AMOUNT },
        // Mortal for the period `exactPaymentLanded` counts on, whatever papi defaults to.
        options: { at: "0xbest", nonce: 0, mortality: { mortal: true, period: 64 } },
      },
    ]);
    expect(events).toEqual(["persist", "submit"]);
    expect(txs).toEqual([{ call: "pay", txHash: "0x1", block: 201 }]);
    expect(state).toMatchObject({ nonce: 0, inFlight: true, balanceBefore: "21000000000" });
  });

  it("keeps the block the attempt is anchored at with it, before it leaves", async () => {
    const seen: unknown[] = [];
    const state = freshExactPayState();
    const { input } = world([{ free: 21_000_000_000n, nonce: 0 }], [], {
      overrides: { anchorNumber: 1_000, onBeforeSubmit: () => void seen.push(state.anchor) },
    });
    await payExactOnce(input, state);
    expect(seen).toEqual([1_000]);
  });

  it("marks the attempt in flight before the driver persists it", async () => {
    const state = freshExactPayState();
    const seen: boolean[] = [];
    const { input } = world([{ free: 21_000_000_000n, nonce: 0 }], [], {
      overrides: {
        onBeforeSubmit: () => {
          seen.push(state.inFlight);
        },
      },
    });
    await payExactOnce(input, state);
    expect(seen).toEqual([true]);
  });

  it("reads a lost answer back from the nonce and the balance, and does not pay again", async () => {
    const state = { ...freshExactPayState(), inFlight: true, balanceBefore: "21000000000" };
    const { input, submits } = world([{ free: 999_000_000n, nonce: 1 }]);
    await payExactOnce(input, state);
    expect(submits).toEqual([]);
  });

  it("sends again at the same nonce when the lost attempt never landed", async () => {
    const state = { ...freshExactPayState(), inFlight: true, balanceBefore: "21000000000" };
    const { input, submits } = world([{ free: 21_000_000_000n, nonce: 0 }]);
    await payExactOnce(input, state);
    expect(submits.map((s) => s.options)).toEqual([
      { at: "0xbest", nonce: 0, mortality: { mortal: true, period: 64 } },
    ]);
    // The balance before the first attempt stands: nothing had left.
    expect(state.balanceBefore).toBe("21000000000");
  });

  it("stops when the key moved past the nonce without the payment showing", async () => {
    const state = { ...freshExactPayState(), inFlight: true, balanceBefore: "21000000000" };
    const { input, submits } = world([{ free: 20_990_000_000n, nonce: 1 }]);
    await expect(payExactOnce(input, state)).rejects.toBeInstanceOf(PaymentUnresolvedError);
    expect(submits).toEqual([]);
  });

  it("stops when the key signed something with no payment in flight", async () => {
    const { input, submits } = world([{ free: 21_000_000_000n, nonce: 1 }]);
    await expect(payExactOnce(input, freshExactPayState())).rejects.toBeInstanceOf(
      PaymentUnresolvedError,
    );
    expect(submits).toEqual([]);
  });

  it("stops when the key is behind the payment's nonce", async () => {
    const state = { ...freshExactPayState(), nonce: 2 };
    const { input } = world([{ free: 21_000_000_000n, nonce: 1 }]);
    await expect(payExactOnce(input, state)).rejects.toBeInstanceOf(PaymentUnresolvedError);
  });

  it("sends nothing when the dry run says the transfer would fail", async () => {
    const state = freshExactPayState();
    const { input, submits } = world([{ free: 1_000n, nonce: 0 }], [], {
      dryRunFails: "InsufficientBalance",
    });
    await expect(payExactOnce(input, state)).rejects.toThrow(/fails on Asset Hub/);
    expect(submits).toEqual([]);
    expect(state.inFlight).toBe(false);
  });

  it("moves to the next nonce after a refusal and gives up after the bound", async () => {
    const state = freshExactPayState();
    const refusals: Outcome[] = Array.from({ length: MAX_REJECTIONS }, () => ({
      ok: false,
      error: "Frozen",
    }));
    const readings = Array.from({ length: MAX_REJECTIONS }, (_, i) => ({
      free: 21_000_000_000n,
      nonce: i,
    }));
    const { input, submits } = world(readings, refusals);
    for (let i = 1; i < MAX_REJECTIONS; i += 1) {
      await expect(payExactOnce(input, state)).rejects.toThrow(/payment rejected/);
      expect(state).toMatchObject({ nonce: i, inFlight: false, rejections: i });
    }
    await expect(payExactOnce(input, state)).rejects.toBeInstanceOf(WithdrawRejectedError);
    expect(submits.map((s) => (s.options as { nonce: number }).nonce)).toEqual([0, 1, 2]);
  });

  it("sizes the floor as the amount, the fee with its headroom, and the existential deposit", async () => {
    const { input } = world([]);
    const floor = await exactPaymentFloor(input.assetHubApi, KEY, DEPOSIT, AMOUNT);
    expect(floor).toBe(AMOUNT + 1_250_000n + 100_000_000n);
  });
});

describe("an earlier attempt, read from the chain alone", () => {
  const inFlight = () => ({
    ...freshExactPayState(),
    inFlight: true,
    balanceBefore: "21000000000",
  });

  it("says nothing landed without reading the key when no attempt is in flight", async () => {
    let reads = 0;
    const { input } = world([], [], {
      overrides: {
        readKey: async () => {
          reads += 1;
          return { free: 0n, nonce: 5 };
        },
      },
    });
    expect(await exactPaymentLanded(input, freshExactPayState())).toBe(false);
    expect(reads).toBe(0);
  });

  it("says it landed once the key signed past its nonce and fell by the amount", async () => {
    const { input, submits } = world([{ free: 999_000_000n, nonce: 1 }]);
    expect(await exactPaymentLanded(input, inFlight())).toBe(true);
    expect(submits).toEqual([]);
  });

  it("says nothing landed while the key still stands at the payment's nonce", async () => {
    const { input } = world([{ free: 21_000_000_000n, nonce: 0 }]);
    expect(await exactPaymentLanded(input, inFlight())).toBe(false);
  });

  it("takes an unlanded attempt out of flight once the chain is past its mortality, and only then", async () => {
    // Anchored at block 1000 and mortal for 64: past 1064 with the nonce unmoved, it never lands.
    const anchored = () => ({ ...inFlight(), anchor: 1_000 });
    for (const [finalized, stillInFlight] of [
      [1_064, true],
      [1_065, false],
    ] as const) {
      const { input } = world([{ free: 21_000_000_000n, nonce: 0 }], [], {
        overrides: { readFinalizedNumber: async () => finalized },
      });
      const state = anchored();
      expect(await exactPaymentLanded(input, state)).toBe(false);
      expect(state.inFlight).toBe(stillInFlight);
      if (!stillInFlight) expect(state).toMatchObject({ balanceBefore: null, anchor: null });
    }
    // With no anchor to count from, nothing can be told: it stays in flight.
    const { input } = world([{ free: 21_000_000_000n, nonce: 0 }], [], {
      overrides: { readFinalizedNumber: async () => 9_999 },
    });
    const unanchored = inFlight();
    await exactPaymentLanded(input, unanchored);
    expect(unanchored.inFlight).toBe(true);
  });

  it("stops where the payment itself would", async () => {
    const { input } = world([{ free: 20_990_000_000n, nonce: 1 }]);
    await expect(exactPaymentLanded(input, inFlight())).rejects.toBeInstanceOf(
      PaymentUnresolvedError,
    );
  });
});
