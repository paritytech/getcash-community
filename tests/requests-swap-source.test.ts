// A stored top-up under a source this build no longer serves (a Chainflip swap from before the
// removal) has no rail to run on: no world is built for it, so the worker is handed nothing and it
// cannot be opened. Its record stays in storage, untouched, and no list shows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { projectCryptoTopUps } from "../app/funding/crypto-top-ups";
import { setRequestsClock } from "../app/funding/requests/model";
import {
  createMemoryKeyedStorage,
  REQUEST_INDEX_KEY,
  requestKey,
  setMirrorStorage,
  setRecordStorage,
} from "../app/funding/requests/storage";
import { useRequestsStore } from "../app/stores/requests";
import { useSessionStore, type ActiveFlowRecord } from "../app/stores/session";
import { requestRefKey, requestRefOf, serializeRequestIndex } from "../app/utils/request-index";
import { awaitingDepositCryptoRecord, FIXTURE_NOW } from "./fixtures/requests";

const { handed } = vi.hoisted(() => ({ handed: [] as string[] }));
vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("../lib/worker-rpc", () => ({
  getStorageWorkerManager: () => ({
    isAvailable: () => true,
    call: async (api: string) => {
      handed.push(api);
    },
    dispose() {},
  }),
}));
// The hosted world as the live session builds it, which turns the source down before it reads
// anything of the host. The store's own reads find an empty burner and no flow slot.
vi.mock("../lib/coinage-live", async () => {
  const { createCoinageSession } = await import("../lib/coinage");
  return {
    createHostedCoinageWorld: (args: object) => createCoinageSession(args as never),
    ensureChainSubmitGrant: async () => {},
    probeTradeBurner: async () => ({ address: "", free: 0n }),
    readHostedTradeCounter: async () => 1,
    readFlowSlot: async () => ({ address: "", slot: null }),
    watchTradeBurner: async () => () => {},
    watchDirectTradeBurner: async () => () => {},
  };
});

const SWAP: ActiveFlowRecord = { ...awaitingDepositCryptoRecord, sourceId: "btc" };
const REF = requestRefOf("btc", 3);
const REFUSED = "live mode does not serve source 'btc'";

describe("a stored top-up under a source this build no longer serves", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const host = createMemoryKeyedStorage();
    setRecordStorage(host);
    setMirrorStorage(null);
    setRequestsClock(() => FIXTURE_NOW);
    handed.length = 0;
    await host.write(requestKey(REF), JSON.stringify(SWAP));
    await host.write(REQUEST_INDEX_KEY, serializeRequestIndex([REF]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    const requests = useRequestsStore();
    requests.stopJobPoll();
    await requests.flush();
    vi.restoreAllMocks();
    setRequestsClock(Date.now);
  });

  it("is kept through boot, off the list, with no world to hand over or open", async () => {
    const requests = useRequestsStore();
    const session = useSessionStore();

    await requests.reconcile("boot");
    expect(requests.entries[requestRefKey(REF)]?.handoffError).toBe(REFUSED);
    expect(handed).toEqual([]);

    expect(await session.openRequest(REF)).toBe(false);
    expect(requests.foregroundRecord).toBeNull();
    expect(session.resuming).toBe(false);

    expect(requests.entries[requestRefKey(REF)]).toBeDefined();
    expect(projectCryptoTopUps(requests.openTopUps, FIXTURE_NOW)).toEqual([]);
    // Joins the background pass the open started.
    await requests.reconcile("refresh");
  });
});
