// The recovery tick over a scripted People: the fee sized once, the claim dry-run and signed with
// the fee in CASH, a lost answer settled from the trap's count, and nothing sent twice.

import { TOKENS } from "@getsome/core";
import { InvalidTxError } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { withFeeMargin } from "./funding-program";
import {
  CLAIM_RESEND_MS,
  freshRecoveryState,
  nativeFeeInCash,
  PEOPLE_CASH_TX_OPTIONS,
  tickRecovery,
  type RecoveryTickInput,
} from "./recovery";

const ADDRESS = "5Burner";
const CLAIMER_HEX = `0x${"07".repeat(32)}`;
const TRAP = { amount: 5_100_000n, key: `0x${"ab".repeat(32)}` as const };
/** People's rate for CASH: 2500 native units to one CASH unit, as a fixed-point number. */
const RATE = 2_500n * 10n ** 18n;
/** The claim's fee as People estimates it, in the native. */
const FEE_NATIVE = 30_862_500n;
/** The same fee in CASH, as the fee payment charges it. */
const FEE = nativeFeeInCash(FEE_NATIVE, RATE);
const TX_HASH = `0x${"55".repeat(32)}`;

type Submit = "ok" | "rejected" | "lost" | "invalid";

/** People as the recovery sees it: the trap's count, the burner's CASH and nonce, the rate, and
 *  the claim as a transaction that prices, dry-runs and submits. */
function scriptedPeople(opts: { count: number; cash: bigint; dryRunRefuses?: boolean }) {
  const state = {
    count: opts.count,
    cash: opts.cash,
    nonce: 3,
    submit: "ok" as Submit,
    feeNative: FEE_NATIVE,
  };
  const seen = {
    feeReads: [] as Array<[string, unknown]>,
    dryRuns: [] as Array<[unknown, unknown]>,
    submits: [] as unknown[],
  };
  const claimArgs: unknown[] = [];
  const api = {
    query: {
      PolkadotXcm: { AssetTraps: { getValue: async () => state.count } },
      AssetRate: { ConversionRateToNative: { getValue: async () => RATE } },
    },
    apis: {
      AccountNonceApi: { account_nonce: async () => state.nonce },
      DryRunApi: {
        dry_run_call: async (origin: unknown, call: unknown) => {
          seen.dryRuns.push([origin, call]);
          return {
            success: true,
            value: {
              execution_result: opts.dryRunRefuses
                ? {
                    success: false,
                    value: {
                      error: {
                        type: "Module",
                        value: { type: "PolkadotXcm", value: { type: "UnknownClaim" } },
                      },
                    },
                  }
                : { success: true, value: {} },
              emitted_events: [],
              forwarded_xcms: [],
            },
          };
        },
      },
    },
    tx: {
      PolkadotXcm: {
        claim_assets: (args: unknown) => {
          claimArgs.push(args);
          return {
            decodedCall: { type: "PolkadotXcm", value: { type: "claim_assets", value: args } },
            getEstimatedFees: async (from: string, options: unknown) => {
              seen.feeReads.push([from, options]);
              return state.feeNative;
            },
            signAndSubmit: async (_signer: unknown, options: unknown) => {
              seen.submits.push(options);
              if (state.submit === "lost") return new Promise<never>(() => {});
              if (state.submit === "invalid") {
                throw new InvalidTxError({ type: "Invalid", value: { type: "Payment" } });
              }
              state.nonce += 1;
              if (state.submit === "rejected") {
                return {
                  ok: false,
                  txHash: TX_HASH,
                  block: { number: 7 },
                  dispatchError: {
                    type: "Module",
                    value: { type: "PolkadotXcm", value: { type: "UnknownClaim" } },
                  },
                };
              }
              state.count -= 1;
              state.cash += TRAP.amount - FEE;
              return { ok: true, txHash: TX_HASH, block: { number: 7 } };
            },
          };
        },
      },
    },
  };
  return { api: api as never, state, seen, claimArgs };
}

type World = ReturnType<typeof scriptedPeople>;

function tick(
  world: World,
  state = freshRecoveryState(),
  overrides: Partial<RecoveryTickInput> = {},
) {
  const txs: unknown[] = [];
  const outcome = tickRecovery(
    {
      peopleApi: world.api,
      address: ADDRESS,
      signer: {} as never,
      claimerHex: CLAIMER_HEX,
      trap: TRAP,
      readCashOnPeople: async () => world.state.cash,
      tickTimeoutMs: 1_000,
      submitTimeoutMs: 20,
      now: () => 1_000_000,
      onTx: (info) => txs.push(info),
      ...overrides,
    },
    state,
  );
  return { outcome, state, txs };
}

describe("nativeFeeInCash", () => {
  it("divides the native fee by People's rate, rounding up where the chain rounds down", () => {
    expect(nativeFeeInCash(17_722_807n, RATE)).toBe(7_090n);
    expect(nativeFeeInCash(2_500n, RATE)).toBe(1n);
    expect(nativeFeeInCash(2_501n, RATE)).toBe(2n);
    expect(nativeFeeInCash(0n, RATE)).toBe(0n);
    expect(() => nativeFeeInCash(1n, 0n)).toThrow(/rate for CASH is zero/);
  });
});

describe("tickRecovery", () => {
  it("waits for the fee: sizes it once with the margin, in CASH off the native estimate and the rate, and sends nothing while the burner holds less", async () => {
    const world = scriptedPeople({ count: 1, cash: 0n });
    const { outcome, state } = tick(world);
    expect(FEE).toBe(12_345n);
    expect(await outcome).toEqual({ step: "funding", held: 0n, feeCash: withFeeMargin(FEE) });
    expect(state.feeCash).toBe(withFeeMargin(FEE));
    expect(state.held).toBe(0n);
    // Priced on the exact transaction as it will be signed, fee asset and extension included.
    expect(world.seen.feeReads).toEqual([[ADDRESS, PEOPLE_CASH_TX_OPTIONS]]);
    // Sized once: the next tick keeps the figure.
    world.state.cash = withFeeMargin(FEE) - 1n;
    expect((await tick(world, state).outcome).step).toBe("funding");
    expect(world.seen.feeReads).toHaveLength(1);
    expect(world.seen.submits).toEqual([]);
    expect(state.attempts).toBe(0);
  });

  it("claims once the burner holds the fee: dry-run as the burner, signed with the fee in CASH, done when the trap is empty", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE) });
    const before: unknown[] = [];
    const { outcome, state, txs } = tick(world, freshRecoveryState(), {
      onBeforeSubmit: () => {
        before.push({ ...state });
      },
    });
    expect(await outcome).toEqual({
      step: "done",
      held: withFeeMargin(FEE) + TRAP.amount - FEE,
      feeCash: withFeeMargin(FEE),
    });
    // The claim names the trapped CASH exactly, as People keys it, and deposits it to the burner.
    expect(world.claimArgs[0]).toEqual({
      assets: {
        type: "V5",
        value: [
          { id: TOKENS.CASH.locationOnPeople, fun: { type: "Fungible", value: TRAP.amount } },
        ],
      },
      beneficiary: {
        type: "V5",
        value: {
          parents: 0,
          interior: {
            type: "X1",
            value: { type: "AccountId32", value: { network: undefined, id: CLAIMER_HEX } },
          },
        },
      },
    });
    expect(world.seen.dryRuns).toEqual([
      [
        { type: "system", value: { type: "Signed", value: ADDRESS } },
        { type: "PolkadotXcm", value: { type: "claim_assets", value: world.claimArgs[0] } },
      ],
    ]);
    expect(world.seen.submits).toEqual([PEOPLE_CASH_TX_OPTIONS]);
    // The nonce and the time are on record before the broadcast leaves, and let go after.
    expect(before).toEqual([
      {
        feeCash: withFeeMargin(FEE),
        round: 0,
        held: withFeeMargin(FEE),
        attempts: 1,
        nonceAtClaim: 3,
        claimSentAt: 1_000_000,
      },
    ]);
    expect(state).toEqual({
      feeCash: withFeeMargin(FEE),
      round: 0,
      held: withFeeMargin(FEE) + TRAP.amount - FEE,
      attempts: 1,
      nonceAtClaim: null,
      claimSentAt: null,
    });
    expect(txs).toEqual([{ call: "claim", txHash: TX_HASH, block: 7, ok: true }]);
  });

  it("is done without a claim when the trap is already empty", async () => {
    const world = scriptedPeople({ count: 0, cash: TRAP.amount });
    const state = { ...freshRecoveryState(), nonceAtClaim: 3, claimSentAt: 999_000 };
    expect((await tick(world, state).outcome).step).toBe("done");
    expect(world.seen.submits).toEqual([]);
    expect(state).toMatchObject({ nonceAtClaim: null, claimSentAt: null });
  });

  it("does not send a claim People would refuse", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE), dryRunRefuses: true });
    const { outcome, state } = tick(world);
    await expect(outcome).rejects.toThrow(/claim not sent: People rejects it: .*UnknownClaim/);
    expect(world.seen.submits).toEqual([]);
    expect(state).toMatchObject({ attempts: 0, nonceAtClaim: null });
  });

  it("waits on a claim whose answer was lost while its nonce stands, and sends again past the mortality or once the nonce moved", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE) });
    world.state.submit = "lost";
    const state = freshRecoveryState();
    await expect(tick(world, state).outcome).rejects.toThrow(/claim submit timed out/);
    expect(state).toMatchObject({ attempts: 1, nonceAtClaim: 3, claimSentAt: 1_000_000 });

    // Soon after, the nonce unmoved: the claim may still land, so nothing goes out.
    world.state.submit = "ok";
    const soon = tick(world, state, { now: () => 1_000_000 + 5_000 });
    expect((await soon.outcome).step).toBe("claiming");
    expect(world.seen.submits).toHaveLength(1);

    // Past the mortality with the nonce still unmoved: the first can no longer land.
    const late = tick(world, state, { now: () => 1_000_000 + CLAIM_RESEND_MS });
    expect((await late.outcome).step).toBe("done");
    expect(world.seen.submits).toHaveLength(2);
    expect(state.attempts).toBe(2);
  });

  it("sends again at once when the nonce moved but the trap is still counted", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE) });
    const state = { ...freshRecoveryState(), nonceAtClaim: 2, claimSentAt: 1_000_000 - 1_000 };
    expect((await tick(world, state).outcome).step).toBe("done");
    expect(world.seen.submits).toHaveLength(1);
  });

  it("a rejected claim fails the tick with People's answer, moves the round on and clears the way for a retry", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE) });
    world.state.submit = "rejected";
    const state = freshRecoveryState();
    const { outcome, txs } = tick(world, state);
    await expect(outcome).rejects.toThrow(/claim rejected: .*UnknownClaim/);
    expect(txs).toEqual([{ call: "claim", txHash: TX_HASH, block: 7, ok: false }]);
    expect(state).toMatchObject({ attempts: 1, round: 1, nonceAtClaim: null, claimSentAt: null });
    world.state.submit = "ok";
    expect((await tick(world, state).outcome).step).toBe("done");
    expect(state.attempts).toBe(2);
    expect(state.round).toBe(1);
  });

  it("a claim the pool refuses was never sent: the marker is let go and the fee sized again, the round moving on only when it grew past what is held", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE) });
    world.state.submit = "invalid";
    const state = freshRecoveryState();
    const { outcome, txs } = tick(world, state);
    await expect(outcome).rejects.toBeInstanceOf(InvalidTxError);
    expect(txs).toEqual([]);
    expect(state).toMatchObject({
      feeCash: withFeeMargin(FEE),
      round: 0,
      attempts: 0,
      nonceAtClaim: null,
      claimSentAt: null,
    });
    expect(world.seen.feeReads).toHaveLength(2);

    // The fee grew past the burner's CASH: the new figure is kept and the round moves on, so
    // the next tick waits for the rest.
    world.state.feeNative = FEE_NATIVE * 2n;
    await expect(tick(world, state).outcome).rejects.toBeInstanceOf(InvalidTxError);
    const grown = withFeeMargin(nativeFeeInCash(FEE_NATIVE * 2n, RATE));
    expect(state).toMatchObject({ feeCash: grown, round: 1, attempts: 0, nonceAtClaim: null });
    world.state.submit = "ok";
    expect((await tick(world, state).outcome).step).toBe("funding");
    expect(world.seen.submits).toHaveLength(2);

    // Topped up to the new figure, the claim goes through.
    world.state.cash = grown;
    expect((await tick(world, state).outcome).step).toBe("done");
    expect(state.round).toBe(1);
  });

  it("keeps the marker on a submit that failed otherwise: the claim may be in flight", async () => {
    const world = scriptedPeople({ count: 1, cash: withFeeMargin(FEE) });
    world.state.submit = "lost";
    const state = freshRecoveryState();
    await expect(tick(world, state).outcome).rejects.toThrow(/claim submit timed out/);
    expect(state).toMatchObject({ attempts: 1, round: 0, nonceAtClaim: 3 });
    expect(world.seen.feeReads).toHaveLength(1);
  });
});
