// The page's side of a crypto withdrawal: confirm records a direct withdrawal to the address and
// hands it over with no provider channel.

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
const LANDING_HEX = `0x${"0a".repeat(32)}`;
const PSM = { tier: "psm", external: "USDT", feeRate: 5_000 } as const;
const DESTINATION = { chain: "Polkadot", asset: "USDT", address: KEY_ADDRESS };

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
const workerCall = vi.fn(async () => ({}));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({ isAvailable: () => true, call: workerCall }),
}));
vi.mock("../lib/withdraw-live", () => ({
  PaymentRefusedError: class PaymentRefusedError extends Error {},
  cashCanMove: async () => true,
  nextWithdrawNumber: async () => 1,
  withdrawKeyFor: async () => ({ address: KEY_ADDRESS, publicKeyHex: KEY_HEX }),
  advanceWithdrawCounter: async () => {},
  requestKeyPayment: async () => {},
  readPaymentStatus: async () => ({ status: "not-found" }),
  sendWithdrawHandoff: vi.fn(async () => {}),
  withdrawHandoff: (
    args: Record<string, unknown> & { key: { address: string; publicKeyHex: string } },
  ) => ({
    label: "wd:eph:usdt-assethub:1",
    keyAddress: args.key.address,
    keyPublicKeyHex: args.key.publicKeyHex,
    amount: String(args.amount),
    destination: args.destination,
    landingHex: args.landingHex,
    rail: args.rail,
    ...(args.sale as { tier: string; external?: string; feeRate?: number }),
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

describe("a crypto withdrawal from the page", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    handedOff.mockClear();
    workerCall.mockClear();
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("records a direct withdrawal landing on the address and hands it over with no channel", async () => {
    const outcome = await useWithdrawalRequest().start({
      destinationId: "usdt-assethub",
      amount: 21_000_000n,
      destination: DESTINATION,
      landingHex: LANDING_HEX,
      sale: PSM,
    });
    expect(outcome.ok).toBe(true);
    const record = useRequestsStore().get(requestRefOf("wd:usdt-assethub", 1)) as WithdrawalRecord;
    expect(record.rail.provider).toBe("direct");
    expect(record.handoff).toMatchObject({ rail: "direct", landingHex: LANDING_HEX, ...PSM });
    expect(record.handoff).not.toHaveProperty("channel");
    expect(handedOff).toHaveBeenCalledTimes(1);
    expect(handedOff.mock.calls[0]?.[2]).toEqual(record.handoff);
  });
});
