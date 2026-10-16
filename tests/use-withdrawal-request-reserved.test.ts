// The PSM's room this app's own withdrawals have spoken for when a route is chosen: the PSM-tier
// ones against the same stable whose redeem is still ahead, counted whole, and nothing else.

import { describe, expect, it } from "vitest";
import {
  PAYMENT_WINDOW_MS,
  type WithdrawJobView,
  type WithdrawalRecord,
  type WithdrawalStatus,
} from "../app/funding/requests/model";
import { psmReserved } from "../app/composables/useWithdrawalRequest";
import { requestRefOf } from "../app/utils/request-index";

const STARTED = Date.UTC(2026, 9, 15, 10, 0, 0);
const KEY_HEX = `0x${"07".repeat(32)}`;
const KEY_ADDRESS = "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ";
const CONVERTING: WithdrawalStatus = { kind: "converting", at: STARTED, step: "convert" };

/** PSM-tier withdrawal `n` of `amount` CASH, converting under the worker unless overridden. */
function withdrawal(
  n: number,
  amount: bigint,
  overrides: Partial<WithdrawalRecord> = {},
  external: "USDT" | "USDC" = "USDT",
): WithdrawalRecord {
  return {
    schema: 2,
    kind: "withdrawal",
    ref: requestRefOf(`wd:${external.toLowerCase()}-assethub`, n),
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: String(amount / 1_000_000n),
    route: "crypto",
    destination: { chain: "Asset Hub", asset: external, address: KEY_ADDRESS },
    key: {
      label: `wd:eph:${external.toLowerCase()}-assethub:${n}`,
      address: KEY_ADDRESS,
      publicKeyHex: KEY_HEX,
    },
    payment: { attempt: 0, requestedAt: STARTED, id: `pay-${n}` },
    deadline: { paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS },
    handoff: {
      label: `wd:eph:${external.toLowerCase()}-assethub:${n}`,
      keyAddress: KEY_ADDRESS,
      keyPublicKeyHex: KEY_HEX,
      amount: amount.toString(),
      destination: { chain: "Asset Hub", asset: external, address: KEY_ADDRESS },
      landingHex: KEY_HEX,
      rail: "direct",
      tier: "psm",
      external,
      feeRate: 5_000,
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Pool",
      slippagePct: 5,
      paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
    },
    status: CONVERTING,
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    witnesses: {},
    ...overrides,
  };
}

/** The worker's witness of the job at `phase`, with the calls it sent. */
const seen = (
  phase: string,
  txs: WithdrawJobView["txs"] = [],
  done = false,
): WithdrawalRecord["witnesses"] => ({
  worker: { known: true, phase, done, fundsSeenAt: STARTED, lastTickAt: STARTED, at: STARTED, txs },
});

/** The redeem still ahead: waiting for the purse, converting with the XCM out, and held by the
 *  PSM with the CASH on the key, which a retry redeems. */
const awaitingPurse = withdrawal(1, 10_000_000n, {
  status: { kind: "awaiting-payment" },
  payment: { attempt: 0 },
});
const converting = withdrawal(2, 30_000_000n, {
  witnesses: seen("redeem", [{ call: "withdraw", txHash: "0x01" }]),
});
const held = withdrawal(3, 40_000_000n, {
  status: { kind: "failed", at: STARTED, recoverable: true },
  failure: { kind: "held", step: "convert", message: "the PSM refused", recoverable: true },
  witnesses: seen("failed", [{ call: "withdraw", txHash: "0x01" }]),
});

/** The redeem behind, or never: the stable sent on, the sale expired, the CASH kept on the key
 *  for good, another pair's redeem, the redeem or the pool exit already out, and a provider's
 *  job past its exit. */
const sent = withdrawal(4, 50_000_000n, { status: { kind: "sent", at: STARTED } });
const expired = withdrawal(5, 60_000_000n, { status: { kind: "expired", at: STARTED } });
const tooSmall = withdrawal(6, 70_000_000n, {
  status: { kind: "failed", at: STARTED, recoverable: false },
  failure: { kind: "unknown", step: "convert", message: "too small", recoverable: false },
  witnesses: seen("failed", [{ call: "withdraw", txHash: "0x01" }]),
});
const usdc = withdrawal(7, 80_000_000n, {}, "USDC");
const redeemed = withdrawal(8, 90_000_000n, {
  witnesses: seen("redeem", [
    { call: "withdraw", txHash: "0x01" },
    { call: "redeem", txHash: "0x02" },
  ]),
});
const exitedToPool = withdrawal(9, 100_000_000n, {
  witnesses: seen("redeem", [
    { call: "withdraw", txHash: "0x01" },
    { call: "pool-exit", txHash: "0x02" },
  ]),
});
const handedToProvider = withdrawal(10, 110_000_000n, {
  rail: { provider: "meld", stage: "waiting", updatedAt: STARTED },
  witnesses: seen("handoff"),
});
const seenDone = withdrawal(11, 120_000_000n, { witnesses: seen("done", [], true) });

describe("the PSM's room spoken for", () => {
  it("counts every PSM withdrawal against the stable whose redeem is still ahead, whole", () => {
    expect(psmReserved([awaitingPurse, converting, held], "USDT")).toBe(80_000_000n);
  });

  it("counts nothing whose redeem is behind it, never comes, or draws on another pair", () => {
    expect(
      psmReserved(
        [sent, expired, tooSmall, usdc, redeemed, exitedToPool, handedToProvider, seenDone],
        "USDT",
      ),
    ).toBe(0n);
  });

  it("counts the other pair's withdrawals against that pair alone", () => {
    expect(psmReserved([converting, usdc], "USDC")).toBe(80_000_000n);
  });

  it("leaves out the withdrawal being decided for", () => {
    expect(psmReserved([awaitingPurse, converting, held], "USDT", awaitingPurse.ref)).toBe(
      70_000_000n,
    );
  });
});
