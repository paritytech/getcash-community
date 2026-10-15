// A world's claim lands on its own request (#62). The worker's marker turns up after the buyer
// saw done, by which time another purchase may be on screen; the claim must not land on that one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setRequestsClock } from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
  type WebStorageLike,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore, type ActiveFlowRecord } from "../app/stores/session";
import { requestRefOf, serializeRequestIndex, type RequestRef } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW, fundedCryptoRecord } from "./fixtures/requests";

type ClaimProgress = (stage: "prompted" | "crediting", claimed?: bigint) => void;

// The hosted world is a stand-in that keeps each world's claim progress callback by trade
// number, so a test can fire it as the hand-off would, long after the world was built.
const { progress } = vi.hoisted(() => ({
  progress: new Map<number, ClaimProgress>(),
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/coinage-live", () => ({
  DEFAULT_SOURCE_ID: "dot-assethub",
  createHostedCoinageWorld: async (args: {
    tradeN?: number;
    sourceId?: string;
    onClaimProgress?: ClaimProgress;
  }) => {
    if (args.onClaimProgress && args.tradeN !== undefined) {
      progress.set(args.tradeN, args.onClaimProgress);
    }
    return {
      session: {
        ready: Promise.resolve(),
        peek: () => ({ phase: "awaiting-deposit" }),
        getState: () => ({ phase: "awaiting-deposit" }),
        subscribe: () => ({ unsubscribe() {} }),
        resume: async () => {},
        quote: async () => ({ source: { formatted: "1", assetSymbol: "DOT", amount: 10n } }),
        dispose() {},
      },
      sourceId: args.sourceId ?? "dot-assethub",
      tradeN: args.tradeN ?? 1,
      refundAddress: null,
      revealRefundKey: () => null,
      runFunding: async () => {},
      dispose() {},
    };
  },
}));

const refOf = (record: ActiveFlowRecord): RequestRef =>
  requestRefOf(record.sourceId, record.tradeN!);

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

/** Yields to the event loop until `predicate` holds, at most `turns` times. */
async function settle(predicate: () => boolean, turns = 20): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("a world's claim progress", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRecordStorage(createMemoryKeyedStorage());
    setMirrorStorage(fakeWebStorage());
    setRequestsClock(() => FIXTURE_NOW);
    progress.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
    setMirrorStorage(null);
  });

  it("lands on the request the world was built for, not the one on screen", async () => {
    const first = refOf(awaitingDepositCryptoRecord);
    const second = refOf(fundedCryptoRecord);
    const storage = createMemoryKeyedStorage();
    setRecordStorage(storage);
    await storage.write(requestKey(first), JSON.stringify(awaitingDepositCryptoRecord));
    await storage.write(requestKey(second), JSON.stringify(fundedCryptoRecord));
    await storage.write(REQUEST_INDEX_KEY, serializeRequestIndex([first, second]));
    const session = useSessionStore();
    const requests = useRequestsStore();

    // The first request on screen, then the second takes it over.
    expect(await session.openRequest(first)).toBe(true);
    expect(await session.openRequest(second)).toBe(true);
    expect(requests.foregroundRecord?.ref).toEqual(second);

    // The first world's hand-off reports its claim now.
    progress.get(first.tradeN)!("crediting", 102_000_000n);
    await settle(() => requests.get(first)?.claimed !== undefined);

    expect(requests.get(first)?.claimed).toBe("102000000");
    expect(requests.get(second)?.claimed).toBeUndefined();
  });
});
