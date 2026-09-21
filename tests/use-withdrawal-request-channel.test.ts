// The page's side of a provider withdrawal: confirm opens the channel with the estimate and the
// key as refund and hands it over, nothing is created when that cannot happen, and a retry after
// a refund reopens a channel for what came back to the key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setRequestsClock, type WithdrawalRecord } from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  setMirrorStorage,
  setRecordStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { requestRefOf } from "../app/utils/request-index";
import { FIXTURE_NOW } from "./fixtures/requests";

const KEY_HEX = `0x${"07".repeat(32)}`;
const KEY_ADDRESS = "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ";
const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const FOUR_DOT = 40_000_000_000n;
const DESTINATION = { chain: "Bitcoin", asset: "BTC", address: BTC_ADDRESS };
const CHANNEL = {
  id: "42",
  address: "5ChannelOnAssetHub",
  openedAt: FIXTURE_NOW,
  expiresAt: FIXTURE_NOW + 86_400_000,
  expectedEgress: "123456",
};

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
const workerCall = vi.fn(async () => ({}));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: workerCall }),
}));
vi.mock("../lib/withdraw-live", () => ({
  PaymentRefusedError: class PaymentRefusedError extends Error {},
  nextWithdrawNumber: async () => 1,
  withdrawKeyFor: async () => ({ address: KEY_ADDRESS, publicKeyHex: KEY_HEX }),
  advanceWithdrawCounter: async () => {},
  requestKeyPayment: async () => {},
  nudgeWithdrawTicks: () => {},
  openWithdrawChannelFor: vi.fn(async () => CHANNEL),
  readWithdrawKeyNativeOnAssetHub: vi.fn(async () => FOUR_DOT),
  sendWithdrawHandoff: vi.fn(async () => {}),
  withdrawHandoff: (
    args: Record<string, unknown> & { key: { address: string; publicKeyHex: string } },
  ) => ({
    label: "wd:eph:btc:1",
    keyAddress: args.key.address,
    keyPublicKeyHex: args.key.publicKeyHex,
    amount: String(args.amount),
    destination: args.destination,
    landingHex: args.landingHex,
    rail: args.rail,
    assetHubGenesis: "0xah",
    peopleGenesis: "0xpe",
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: args.paymentExpiresAt,
    ...(args.channel === undefined ? {} : { channel: args.channel }),
  }),
}));

import * as live from "../lib/withdraw-live";
import { useWithdrawalRequest } from "../app/composables/useWithdrawalRequest";

const opened = vi.mocked(live.openWithdrawChannelFor);
const readKey = vi.mocked(live.readWithdrawKeyNativeOnAssetHub);
const handedOff = vi.mocked(live.sendWithdrawHandoff);

function fakeWebStorage(): WebStorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

const start = (expectedNative?: bigint) =>
  useWithdrawalRequest().start({
    destinationId: "btc",
    amount: 21_000_000n,
    destination: DESTINATION,
    landingHex: null,
    rail: "chainflip",
    ...(expectedNative === undefined ? {} : { expectedNative }),
  });

describe("a provider withdrawal from the page", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    opened.mockClear().mockResolvedValue(CHANNEL);
    readKey.mockClear();
    handedOff.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("opens the channel at confirm, for the estimate, refunding to the key, and hands it over", async () => {
    const outcome = await start(FOUR_DOT);
    expect(outcome.ok).toBe(true);
    expect(opened).toHaveBeenCalledWith({
      amountNative: FOUR_DOT,
      destination: { id: "btc", ...DESTINATION },
      keyPublicKeyHex: KEY_HEX,
    });
    const record = useRequestsStore().get(requestRefOf("wd:btc", 1)) as WithdrawalRecord;
    expect(record.rail.provider).toBe("chainflip");
    expect(record.handoff.channel).toEqual(CHANNEL);
    // The native lands on the key itself; the key pays the channel from there.
    expect(record.handoff.landingHex).toBe(KEY_HEX);
    expect(handedOff).toHaveBeenCalledTimes(1);
    expect(handedOff.mock.calls[0]?.[2]).toMatchObject({ channel: CHANNEL, rail: "chainflip" });
  });

  it("creates nothing without an estimate to quote the channel for", async () => {
    const outcome = await start();
    expect(outcome).toEqual({
      ok: false,
      ref: null,
      reason: "The estimate is not available right now.",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(useRequestsStore().records).toEqual([]);
  });

  it("creates nothing when the provider cannot open a channel", async () => {
    opened.mockRejectedValueOnce(new Error("Asset HubDot is disabled"));
    const outcome = await start(FOUR_DOT);
    expect(outcome.ok).toBe(false);
    expect(outcome.ref).toBeNull();
    expect(outcome.ok === false && outcome.reason).toMatch(/could not be reached.*disabled/);
    expect(useRequestsStore().records).toEqual([]);
    expect(handedOff).not.toHaveBeenCalled();
  });

  it("reopens a channel for what came back to the key when a refunded swap is retried", async () => {
    await start(FOUR_DOT);
    const ref = requestRefOf("wd:btc", 1);
    const requests = useRequestsStore();
    // The worker saw the payment, landed the native on the key, and the swap refunded: the
    // record fails at the send step, retryable.
    await requests.observe(ref, {
      source: "worker",
      at: FIXTURE_NOW + 60_000,
      withdrawJob: {
        phase: "failed",
        failure: "rail-failed",
        landed: true,
        done: false,
        fundsSeenAt: FIXTURE_NOW + 30_000,
        lastTickAt: FIXTURE_NOW + 60_000,
        rail: { status: "failed" },
      },
    });
    expect(requests.get(ref)).toMatchObject({
      status: { kind: "failed", recoverable: true },
      failure: { kind: "refunded", step: "send" },
    });
    const fresh = { ...CHANNEL, id: "43", address: "5FreshChannel" };
    opened.mockResolvedValueOnce(fresh);
    readKey.mockResolvedValueOnce(39_000_000_000n);
    handedOff.mockClear();

    expect(await useWithdrawalRequest().retry(ref)).toBe(true);
    expect(readKey).toHaveBeenCalledWith(KEY_HEX);
    expect(opened).toHaveBeenLastCalledWith({
      amountNative: 39_000_000_000n,
      destination: { id: "btc", ...DESTINATION },
      keyPublicKeyHex: KEY_HEX,
    });
    const after = requests.get(ref) as WithdrawalRecord;
    expect(after.status).toEqual({ kind: "sending", at: FIXTURE_NOW });
    expect(after.rail).toEqual({ provider: "chainflip", stage: "waiting", updatedAt: FIXTURE_NOW });
    expect(after.handoff.channel).toEqual(fresh);
    expect(handedOff).toHaveBeenCalledTimes(1);
    expect(handedOff.mock.calls[0]?.[2]).toMatchObject({ channel: fresh });
  });
});
