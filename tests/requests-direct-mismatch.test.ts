// A Polkadot deposit is only a deposit once the picked token reaches what the worker converts at.
// Less than that, or a balance in another direct token, keeps the request waiting and records what
// arrived. It still expires at its deadline, and a short balance never brings an ended one back.
// Accepting a mismatch rewrites the request's terms. Chainflip and Meld picks are left alone:
// there any balance is the deposit, since the provider delivers what was asked.

import { describe, expect, it } from "vitest";
import { createFundingProgressSnapshot, progressProviderForSource } from "../app/funding/progress";
import { reduce } from "../app/funding/requests/reducer";
import type {
  AcceptedDepositTerms,
  Observation,
  TopUpRecord,
  WorkerHandoffPayload,
} from "../app/funding/requests/model";

const ASKED = 10_093_533n;
const DEADLINE = 86_400_000;

function record(
  sourceId: string,
  opts: {
    asset?: string;
    chain?: string;
    amount?: bigint;
    handoff?: Partial<WorkerHandoffPayload>;
  } = {},
): TopUpRecord {
  const assetSymbol = opts.asset ?? "dotUSD";
  return {
    schema: 2,
    kind: "top-up",
    ref: { sourceId, tradeN: 3 },
    rev: 0,
    updatedAt: 0,
    startedAt: 0,
    amountHuman: "10",
    chain: opts.chain ?? "Polkadot",
    asset: assetSymbol,
    sourceId,
    progress: createFundingProgressSnapshot(progressProviderForSource(sourceId).createProfile({}), {
      preDetectionEstimateText: "",
    }),
    route: "crypto",
    deposit: {
      address: "5Burner",
      amount: (opts.amount ?? ASKED).toString(),
      formatted: "10.093533",
      assetSymbol,
      expiresAt: 0,
    },
    ...(opts.handoff ? { handoff: opts.handoff as WorkerHandoffPayload } : {}),
    deadline: { depositExpiresAt: DEADLINE, source: "route" },
    status: { kind: "awaiting-deposit" },
    rail: { provider: "manual", status: "waiting", stage: "waiting", updatedAt: 0 },
    witnesses: {},
  };
}

const reading = (
  held: bigint,
  at: number,
  stray?: { asset: string; amount: string } | null,
): Observation => ({
  source: "chain",
  at,
  burnerNative: held.toString(),
  finality: "best",
  via: "probe",
  ...(stray === undefined ? {} : { stray }),
});

describe("a Polkadot deposit", () => {
  it("stays waiting and records a short deposit, then moves on once the rest arrives", () => {
    const short = reduce(record("dotusd-assethub"), reading(8_000_000n, 10, null));
    expect(short.status).toEqual({ kind: "awaiting-deposit" });
    expect(short.depositMismatch).toEqual({
      kind: "short",
      asset: "dotUSD",
      amount: "8000000",
      at: 10,
    });

    const complete = reduce(short, reading(ASKED, 20, null));
    expect(complete.status).toMatchObject({ kind: "deposit-seen", via: "chain" });
    expect(complete.depositMismatch).toBeUndefined();
  });

  it("moves on for exactly the ask and for more than it", () => {
    for (const held of [ASKED, ASKED + 5_000_000n]) {
      const seen = reduce(record("dotusd-assethub"), reading(held, 10, null));
      expect(seen.status.kind).toBe("deposit-seen");
      expect(seen.depositMismatch).toBeUndefined();
    }
  });

  it("moves on at the worker's own gate, not at the ask's headroom, on the pool tiers", () => {
    // The stable pool carries its gate on the hand-off: the plain quote without the headroom.
    const gate = 9_900_000n;
    const stable = record("usdc-assethub", {
      asset: "USDC",
      handoff: { tier: "pool", external: "USDC", quotedDeposit: gate.toString() },
    });
    expect(reduce(stable, reading(gate, 10, null)).status.kind).toBe("deposit-seen");
    expect(reduce(stable, reading(gate - 1n, 10, null)).depositMismatch?.kind).toBe("short");

    // The native pool's gate is live, so it is the ask with the headroom taken back out.
    const keep = 200_000_000n;
    const askedDot = 30_000_000_000n;
    const native = record("dot-assethub", {
      asset: "DOT",
      amount: askedDot,
      handoff: { tier: "pool", keepNativeForFees: keep.toString() },
    });
    const plain = keep + ((askedDot - keep) * 100n) / 102n;
    expect(reduce(native, reading(plain, 10, null)).status.kind).toBe("deposit-seen");
    expect(reduce(native, reading(plain - 1n, 10, null)).depositMismatch?.kind).toBe("short");
  });

  it("records a balance in another direct token as a wrong-token deposit", () => {
    const next = reduce(
      record("usdc-assethub", { asset: "USDC" }),
      reading(0n, 10, { asset: "USDT", amount: "10000000" }),
    );
    expect(next.status).toEqual({ kind: "awaiting-deposit" });
    expect(next.depositMismatch).toEqual({
      kind: "token",
      asset: "USDT",
      amount: "10000000",
      at: 10,
    });
  });

  it("clears a mismatch when the watch finds the account empty, and keeps it on other reads", () => {
    const short = reduce(record("dotusd-assethub"), reading(8_000_000n, 10, null));
    // A probe that carries no view of the other tokens says nothing about the mismatch.
    expect(reduce(short, reading(0n, 20)).depositMismatch).toBeDefined();
    // The watch sees every token and nothing: the funds were taken back.
    expect(reduce(short, reading(0n, 30, null)).depositMismatch).toBeUndefined();
  });

  it("names the other token when both it and less of the picked one are on the account", () => {
    const next = reduce(
      record("usdc-assethub", { asset: "USDC" }),
      reading(3_000_000n, 10, { asset: "USDT", amount: "10000000" }),
    );
    expect(next.depositMismatch).toMatchObject({ kind: "token", asset: "USDT" });
  });

  it("expires at its deadline like any request, mismatch or not", () => {
    const short = reduce(record("dotusd-assethub"), reading(8_000_000n, 10, null));
    expect(reduce(short, { source: "clock", at: DEADLINE + 1 }).status.kind).toBe("expired");
  });

  it("is not brought back by a balance short of the gate once it has ended", () => {
    const expired = reduce(record("dotusd-assethub"), { source: "clock", at: DEADLINE + 1 });
    const cancelled = reduce(record("dotusd-assethub"), {
      source: "user",
      at: 5,
      event: "cancelled",
      depositExpiresAt: 0,
    });
    for (const ended of [expired, cancelled]) {
      const read = reduce(ended, reading(8_000_000n, DEADLINE + 10));
      expect(read.status.kind).toBe(ended.status.kind);
      expect(read.depositMismatch).toBeUndefined();
    }
  });

  it("takes the accepted terms while still on the deposit, and drops the mismatch", () => {
    const short = reduce(record("dotusd-assethub"), reading(8_000_000n, 10, null));
    const terms: AcceptedDepositTerms = {
      amountHuman: "7.9",
      asset: "dotUSD",
      deposit: { amount: "8000000", formatted: "8", assetSymbol: "dotUSD" },
      conversion: { tier: "teleport" },
      handoff: {
        settleAmount: "7900000",
        tier: "teleport",
        quotedDeposit: "8000000",
      } as AcceptedDepositTerms["handoff"],
    };
    const accepted = reduce(short, { source: "user", at: 20, event: "deposit-accepted", terms });
    expect(accepted).toMatchObject({
      amountHuman: "7.9",
      sourceAmount: "8",
      conversion: { tier: "teleport" },
      deposit: { amount: "8000000", address: "5Burner" },
    });
    expect(accepted.depositMismatch).toBeUndefined();
    // The same balance now covers the new gate, so the next reading is the deposit.
    expect(reduce(accepted, reading(8_000_000n, 30, null)).status.kind).toBe("deposit-seen");
  });

  it("gives a Chainflip pick none of this: any balance is its deposit", () => {
    const btc = reduce(record("btc", { asset: "BTC", chain: "Bitcoin" }), reading(1n, 10));
    expect(btc.status.kind).toBe("deposit-seen");
    expect(btc.depositMismatch).toBeUndefined();
    // Also when it runs under a Polkadot source id, as a Chainflip pick does in this build.
    const demo = reduce(
      record("dot-assethub", { asset: "BTC", chain: "Bitcoin" }),
      reading(1n, 10, null),
    );
    expect(demo.status.kind).toBe("deposit-seen");
    expect(demo.depositMismatch).toBeUndefined();
  });
});
