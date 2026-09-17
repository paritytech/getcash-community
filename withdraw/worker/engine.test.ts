import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKeypair } from "@getsome/ephemeral";
import { PaymentStatusErr } from "@novasamatech/host-api";
import { withdrawalAccountFromPublicKey } from "../chain/account";

const mocks = vi.hoisted(() => {
  const state = {
    entries: new Map<string, unknown>(),
    clients: [] as Array<{ genesis: string; destroyed: boolean }>,
  };
  return {
    ...state,
    store: {
      readJSON: vi.fn(async (key: string) => state.entries.get(key) ?? null),
      writeJSON: vi.fn(async (key: string, value: unknown) => {
        state.entries.set(key, JSON.parse(JSON.stringify(value)));
      }),
    },
    deriveEntropy: vi.fn(),
    getProvider: vi.fn(),
    readBalance: vi.fn(),
    requestPayment: vi.fn(),
    readStatus: vi.fn(),
    prepare: vi.fn(),
    readPeopleBalance: vi.fn(),
    readAssetHubBalance: vi.fn(),
    signAndSubmit: vi.fn(),
  };
});

vi.mock("./host", () => ({
  deriveWithdrawEntropy: mocks.deriveEntropy,
  getWithdrawHostProvider: mocks.getProvider,
  getWithdrawStorage: async () => mocks.store,
  readSpendablePrivateCash: mocks.readBalance,
  requestWithdrawPayment: mocks.requestPayment,
  readWithdrawPaymentStatus: mocks.readStatus,
}));

vi.mock("../chain/papi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareWithdrawalTransaction: mocks.prepare,
  readPeopleBalance: mocks.readPeopleBalance,
  readAssetHubBalance: mocks.readAssetHubBalance,
}));

vi.mock("polkadot-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createClient: (provider: { genesis: string }) => {
    const client = {
      genesis: provider.genesis,
      destroyed: false,
      getChainSpecData: async () => ({ genesisHash: provider.genesis }),
      getTypedApi: () => ({ client, genesis: provider.genesis }),
      destroy: () => {
        client.destroyed = true;
      },
    };
    mocks.clients.push(client);
    return client;
  },
}));

const STORE_KEY = "getcash.withdraw.jobs";
const SEED = new Uint8Array(32).fill(7);
const KEYPAIR = deriveKeypair(SEED);
const ACCOUNT = withdrawalAccountFromPublicKey(KEYPAIR.publicKey);
const AMOUNT = "1000";
const ID1 = `0x${"11".repeat(32)}`;
const ID2 = `0x${"22".repeat(32)}`;
const ID3 = `0x${"33".repeat(32)}`;

type Engine = typeof import("./engine");
type StoredRecordFixture = Record<string, unknown> & {
  id?: string;
  label?: string;
  amount?: string;
  phase?: string;
  done?: boolean;
  updatedAt: number;
  account?: unknown;
  payment?: unknown;
  submission?: unknown;
};
type StoredStateFixture = { v: number; records: Record<string, StoredRecordFixture> };
type FakeApi = { client: { destroyed: boolean } };

async function freshEngine(): Promise<Engine> {
  vi.resetModules();
  return await import("./engine");
}

function state(): StoredStateFixture {
  return mocks.entries.get(STORE_KEY) as StoredStateFixture;
}

function record(id = ID1): StoredRecordFixture {
  const found = state().records[id];
  if (!found) throw new Error(`missing test record ${id}`);
  return found;
}

function setState(value: unknown): void {
  mocks.entries.set(STORE_KEY, JSON.parse(JSON.stringify(value)));
}

function labelFor(id: string): string {
  return `getcash:withdraw:v1:${id}`;
}

function preparedTx(
  sign: (...args: unknown[]) => Promise<unknown> = (...args: unknown[]) =>
    mocks.signAndSubmit(...args),
) {
  return {
    amounts: {
      peopleBalance: 1000n,
      assetHubBalanceBefore: 10n,
      pUsdTransfer: 700n,
      maxPUsdSwapInput: 20n,
      pasToSwap: 30n,
    },
    transaction: { signAndSubmit: sign },
    options: { fee: "pUSD" },
    pool: {},
    paymentInfoPasses: [],
  };
}

async function start(engine: Engine, id = ID1, amount = AMOUNT) {
  return await engine.startWithdraw({ id, amount });
}

async function tickPaymentRegistered(engine: Engine): Promise<void> {
  await start(engine);
  await engine.tickAllWithdrawals();
  expect(record().phase).toBe("payment-pending");
}

function seedAwaitingAssetHubCredit(id = ID1): void {
  const at = Date.now();
  setState({
    v: 1,
    records: {
      [id]: {
        v: 1,
        id,
        amount: AMOUNT,
        label: labelFor(id),
        phase: "awaiting-asset-hub-credit",
        done: false,
        createdAt: at,
        updatedAt: at,
        lastTickAt: at,
        account: {
          label: labelFor(id),
          peopleAddress: ACCOUNT.address,
          publicKeyHex: ACCOUNT.publicKeyHex,
        },
        payment: {
          id,
          requestedAmount: AMOUNT,
          phase: "terminal",
          status: "completed",
          actualClaimed: AMOUNT,
          terminalAt: at,
        },
        peopleCredit: { target: AMOUNT, balance: AMOUNT, finalizedAt: at },
        prepared: {
          peopleBalance: AMOUNT,
          assetHubBalanceBefore: "10",
          pUsdTransfer: "700",
          maxPUsdSwapInput: "20",
          pasToSwap: "30",
        },
        submission: {
          phase: "pending",
          attempts: 1,
          at,
          expectedPUsd: "700",
          assetHubBalanceBefore: "10",
        },
      },
    },
  });
}

beforeEach(() => {
  vi.useRealTimers();
  mocks.entries.clear();
  mocks.clients.length = 0;
  mocks.store.readJSON
    .mockReset()
    .mockImplementation(async (key: string) => mocks.entries.get(key) ?? null);
  mocks.store.writeJSON.mockReset().mockImplementation(async (key: string, value: unknown) => {
    mocks.entries.set(key, JSON.parse(JSON.stringify(value)));
  });
  mocks.deriveEntropy.mockReset().mockResolvedValue(SEED);
  mocks.getProvider.mockReset().mockImplementation(async (genesis: string) => ({ genesis }));
  mocks.readBalance.mockReset().mockResolvedValue({ available: 2000n });
  mocks.requestPayment.mockReset().mockResolvedValue(undefined);
  mocks.readStatus.mockReset().mockResolvedValue({ type: "processing" });
  mocks.prepare.mockReset().mockImplementation(async () => preparedTx());
  mocks.readPeopleBalance.mockReset().mockResolvedValue(0n);
  mocks.readAssetHubBalance.mockReset().mockResolvedValue(0n);
  mocks.signAndSubmit.mockReset().mockResolvedValue({
    ok: true,
    txHash: `0x${"44".repeat(32)}`,
    block: { number: 9 },
    events: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withdraw worker engine", () => {
  it("records a durable handoff without deriving identity or calling payment", async () => {
    const engine = await freshEngine();
    const first = await start(engine);
    expect(first).toMatchObject({ known: true, id: ID1, amount: AMOUNT, phase: "created" });
    expect(record()).toMatchObject({ id: ID1, label: labelFor(ID1), phase: "created" });
    expect(mocks.deriveEntropy).not.toHaveBeenCalled();
    expect(mocks.requestPayment).not.toHaveBeenCalled();

    await expect(start(engine)).resolves.toMatchObject({ id: ID1, amount: AMOUNT });
    await expect(start(engine, ID1, "1001")).resolves.toMatchObject({ error: "invalid" });
    await expect(start(engine, ID2)).resolves.toMatchObject({
      error: "invalid",
      reason: "another withdrawal is already active",
    });
  });

  it("serializes concurrent starts so only one active id wins", async () => {
    const engine = await freshEngine();
    const results = await Promise.all([start(engine, ID1), start(engine, ID2), start(engine, ID3)]);
    expect(results.filter((result) => "known" in result && result.known)).toHaveLength(1);
    expect(results.filter((result) => "error" in result)).toHaveLength(2);
    expect(Object.keys(state().records)).toHaveLength(1);
  });

  it("allows a later withdrawal after terminal records while keeping old labels", async () => {
    const engine = await freshEngine();
    await start(engine);
    record().phase = "done";
    record().done = true;
    record().updatedAt += 1;
    setState(state());

    await expect(start(engine, ID2, "500")).resolves.toMatchObject({
      known: true,
      id: ID2,
      phase: "created",
    });
    expect(Object.keys(state().records).sort()).toEqual([ID1, ID2].sort());
    expect(record(ID1).label).toBe(labelFor(ID1));

    record(ID2).phase = "unknown";
    record(ID2).submission = {
      phase: "unknown",
      attempts: 1,
      at: Date.now(),
      expectedPUsd: "700",
      assetHubBalanceBefore: "10",
    };
    setState(state());
    await expect(start(engine, ID3, "250")).resolves.toMatchObject({
      error: "invalid",
      reason: "another withdrawal is already active",
    });
  });

  it("fails closed when storage cannot persist the account marker before payment", async () => {
    const engine = await freshEngine();
    await start(engine);
    mocks.store.writeJSON.mockRejectedValue(new Error("storage down"));
    await expect(engine.tickAllWithdrawals()).rejects.toThrow("storage down");
    expect(mocks.requestPayment).not.toHaveBeenCalled();
  });

  it("requires the amount to be strictly below spendable CASH before the first request", async () => {
    const engine = await freshEngine();
    await start(engine);
    mocks.readBalance.mockResolvedValueOnce({ available: 1000n });
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "failed",
      failure: "insufficient-private-cash",
    });
    expect(mocks.requestPayment).not.toHaveBeenCalled();
    await expect(start(engine, ID2, "500")).resolves.toMatchObject({ known: true, id: ID2 });
  });

  it("fails closed when storage cannot persist the requesting-payment marker", async () => {
    const engine = await freshEngine();
    await start(engine);
    mocks.store.writeJSON.mockImplementation(async (key: string, value: unknown) => {
      const next = value as StoredStateFixture;
      if (next.records[ID1]?.phase === "requesting-payment") {
        throw new Error("request marker down");
      }
      mocks.entries.set(key, JSON.parse(JSON.stringify(value)));
    });

    await expect(engine.tickAllWithdrawals()).rejects.toThrow("request marker down");
    expect(mocks.requestPayment).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous payment id live and queries status without another payment request", async () => {
    vi.useFakeTimers();
    const engine = await freshEngine();
    let resolvePayment: (() => void) | undefined;
    mocks.requestPayment.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePayment = resolve;
      }),
    );
    mocks.readStatus.mockRejectedValueOnce(new PaymentStatusErr.PaymentNotFound());

    await start(engine);
    const firstTick = engine.tickAllWithdrawals();
    await vi.advanceTimersByTimeAsync(46_000);
    await firstTick;
    expect(record()).toMatchObject({
      phase: "payment-pending",
      payment: { phase: "registration-unknown" },
    });

    await engine.tickAllWithdrawals();
    expect(record().phase).toBe("payment-pending");
    expect(record().lastError).toContain("does not know the payment id yet");
    expect(mocks.requestPayment).toHaveBeenCalledTimes(1);
    expect(mocks.readStatus).toHaveBeenCalledTimes(1);

    mocks.readStatus.mockResolvedValueOnce({ type: "completed" });
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "awaiting-people-credit",
      payment: { status: "completed", actualClaimed: AMOUNT },
    });
    expect(mocks.requestPayment).toHaveBeenCalledTimes(1);
    resolvePayment?.();
  });

  it("records partial payment and waits for the actual finalized People credit", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    mocks.readStatus.mockResolvedValueOnce({ type: "partiallyClaimed", actualClaimed: 600n });
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "awaiting-people-credit",
      payment: { status: "partiallyClaimed", actualClaimed: "600" },
    });

    mocks.readPeopleBalance.mockResolvedValueOnce(500n);
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "awaiting-people-credit",
      peopleCredit: { target: "600", balance: "500" },
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("resumes a saved payment marker after restart by checking status before retrying", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    const restarted = await freshEngine();
    mocks.readStatus.mockRejectedValueOnce(new Error("status unavailable"));
    await restarted.tickAllWithdrawals();

    expect(record()).toMatchObject({
      id: ID1,
      phase: "payment-pending",
      lastError: "status unavailable",
    });
    await expect(start(restarted, ID2, "500")).resolves.toMatchObject({
      error: "invalid",
      reason: "another withdrawal is already active",
    });
    mocks.readStatus.mockResolvedValueOnce({ type: "completed" });
    await restarted.tickAllWithdrawals();
    expect(record()).toMatchObject({ phase: "awaiting-people-credit", id: ID1 });
    expect(mocks.requestPayment).toHaveBeenCalledTimes(1);
  });

  it("does not replace an ambiguous payment id after NotFound and reduced balance", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    const restarted = await freshEngine();
    mocks.readStatus.mockRejectedValueOnce(new PaymentStatusErr.PaymentNotFound());
    mocks.readBalance.mockResolvedValueOnce({ available: 500n });

    await restarted.tickAllWithdrawals();

    expect(record()).toMatchObject({
      id: ID1,
      phase: "unknown",
      failure: "payment-intent-unresolved",
      payment: { id: ID1, phase: "registration-unknown" },
    });
    expect(mocks.requestPayment).toHaveBeenCalledTimes(1);
    await expect(start(restarted, ID2, "250")).resolves.toMatchObject({
      error: "invalid",
      reason: "another withdrawal is already active",
    });
  });

  it("pauses a processing payment after the active deadline while blocking new starts", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    const stored = state();
    stored.records[ID1]!.createdAt = Date.now() - 901_000;
    setState(stored);
    mocks.readStatus.mockResolvedValueOnce({ type: "processing" });

    await expect(engine.tickAllWithdrawals()).resolves.toEqual({ ticked: 0, busy: false });

    expect(record()).toMatchObject({
      id: ID1,
      phase: "unknown",
      failure: "payment-status-unknown",
      payment: { id: ID1, status: "processing" },
    });
    await expect(engine.hasLiveWithdrawals()).resolves.toBe(false);
    await expect(start(engine, ID2, "250")).resolves.toMatchObject({
      error: "invalid",
      reason: "another withdrawal is already active",
    });
  });

  it("keeps PAPI clients alive through submit and completes only on Asset Hub delta", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    mocks.readStatus.mockResolvedValueOnce({ type: "completed" });
    await engine.tickAllWithdrawals();
    mocks.readPeopleBalance.mockResolvedValueOnce(1000n);
    mocks.prepare.mockImplementationOnce(async ({ peopleApi, assetHubApi }) =>
      preparedTx(async () => {
        if ((peopleApi as FakeApi).client.destroyed || (assetHubApi as FakeApi).client.destroyed) {
          throw new Error("client destroyed before submit");
        }
        return {
          ok: true,
          txHash: `0x${"55".repeat(32)}`,
          block: { number: 12 },
          events: [
            { type: "PolkadotXcm", value: { type: "Attempted", value: { type: "Complete" } } },
          ],
        };
      }),
    );

    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "awaiting-asset-hub-credit",
      submission: { phase: "finalized", txHash: `0x${"55".repeat(32)}` },
    });
    expect((record().submission as { xcmAttempt?: unknown }).xcmAttempt).toEqual({
      type: "Complete",
    });

    mocks.readAssetHubBalance.mockResolvedValueOnce(709n);
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "awaiting-asset-hub-credit",
      assetHubCredit: { balanceBefore: "10", balance: "709", delta: "699" },
    });

    mocks.readAssetHubBalance.mockResolvedValueOnce(710n);
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({
      phase: "done",
      done: true,
      assetHubCredit: { expected: "700", balance: "710", delta: "700" },
    });
  });

  it("does not resubmit after submit timeout and still reconciles finalized Asset Hub credit", async () => {
    vi.useFakeTimers();
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    mocks.readStatus.mockResolvedValueOnce({ type: "completed" });
    await engine.tickAllWithdrawals();
    mocks.readPeopleBalance.mockResolvedValueOnce(1000n);
    let resolveSubmit: ((value: unknown) => void) | undefined;
    mocks.signAndSubmit.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    const submitTick = engine.tickAllWithdrawals();
    await vi.advanceTimersByTimeAsync(121_000);
    await submitTick;
    expect(record()).toMatchObject({
      phase: "awaiting-asset-hub-credit",
      submission: { phase: "unknown", attempts: 1 },
    });
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);

    mocks.readAssetHubBalance.mockResolvedValueOnce(710n);
    await engine.tickAllWithdrawals();
    expect(record()).toMatchObject({ phase: "done", done: true });
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);
    resolveSubmit?.({ ok: true });
  });

  it("records XCM incomplete evidence without treating it as success before credit", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    mocks.readStatus.mockResolvedValueOnce({ type: "completed" });
    await engine.tickAllWithdrawals();
    mocks.readPeopleBalance.mockResolvedValueOnce(1000n);
    mocks.signAndSubmit.mockResolvedValueOnce({
      ok: true,
      txHash: `0x${"66".repeat(32)}`,
      block: { number: 14 },
      events: [
        { type: "PolkadotXcm", value: { type: "Attempted", value: { type: "Incomplete" } } },
      ],
    });

    await engine.tickAllWithdrawals();
    mocks.readAssetHubBalance.mockResolvedValueOnce(10n);
    await engine.tickAllWithdrawals();

    expect(record()).toMatchObject({
      phase: "awaiting-asset-hub-credit",
      assetHubCredit: { expected: "700", balance: "10", delta: "0" },
    });
    expect((record().submission as { xcmAttempt?: unknown }).xcmAttempt).toEqual({
      type: "Incomplete",
    });
  });

  it("resumes a pending submission after restart by observing credit only", async () => {
    seedAwaitingAssetHubCredit();
    const engine = await freshEngine();
    mocks.readAssetHubBalance.mockResolvedValueOnce(710n);
    await engine.tickAllWithdrawals();

    expect(record()).toMatchObject({ phase: "done", done: true });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
  });

  it("fails closed when storage cannot persist the submitting marker", async () => {
    const engine = await freshEngine();
    await tickPaymentRegistered(engine);
    mocks.readStatus.mockResolvedValueOnce({ type: "completed" });
    await engine.tickAllWithdrawals();
    mocks.readPeopleBalance.mockResolvedValueOnce(1000n);
    mocks.store.writeJSON.mockImplementation(async (key: string, value: unknown) => {
      const next = value as StoredStateFixture;
      if (next.records[ID1]?.phase === "submitting") {
        throw new Error("submit marker down");
      }
      mocks.entries.set(key, JSON.parse(JSON.stringify(value)));
    });

    await expect(engine.tickAllWithdrawals()).rejects.toThrow("submit marker down");
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
  });

  it("lets unknown recoverable records block starts without holding background keepalive", async () => {
    const engine = await freshEngine();
    await start(engine);
    record().account = {
      label: labelFor(ID1),
      peopleAddress: ACCOUNT.address,
      publicKeyHex: ACCOUNT.publicKeyHex,
    };
    record().phase = "unknown";
    record().failure = "asset-hub-credit-unknown";
    record().submission = {
      phase: "unknown",
      attempts: 1,
      at: Date.now(),
      expectedPUsd: "700",
      assetHubBalanceBefore: "10",
    };
    setState(state());

    await expect(engine.hasLiveWithdrawals()).resolves.toBe(false);
    await expect(start(engine, ID2, "500")).resolves.toMatchObject({
      error: "invalid",
      reason: "another withdrawal is already active",
    });
    await expect(engine.tickAllWithdrawals()).resolves.toEqual({ ticked: 0, busy: false });

    mocks.readAssetHubBalance.mockResolvedValueOnce(710n);
    await expect(engine.tickAllWithdrawals({ includeUnknown: true })).resolves.toEqual({
      ticked: 0,
      busy: false,
    });
    expect(record()).toMatchObject({ phase: "done", done: true });
  });

  it("does not overwrite malformed or unknown-version storage", async () => {
    const engine = await freshEngine();
    mocks.entries.set(STORE_KEY, { v: 99, records: {} });
    await expect(start(engine)).resolves.toMatchObject({ error: "invalid" });
    expect(mocks.entries.get(STORE_KEY)).toEqual({ v: 99, records: {} });

    mocks.entries.set(STORE_KEY, { v: 1, records: { [ID1]: { v: 1, id: ID1, amount: "0" } } });
    await expect(engine.withdrawStatus({ id: ID1 })).resolves.toMatchObject({
      known: false,
      reason: expect.stringContaining("amount"),
    });
  });
});
