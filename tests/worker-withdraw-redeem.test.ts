// The worker's redeem step, offline: the chains are scripted through the clients the engine opens,
// the tick and the records are real. What this pins is the glue the tick's own tests cannot see:
// the exit is signed with Asset Hub's anchor, not People's, the exit's state is persisted and
// read back, and the user's switch makes the same step sell on the pool.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountId } from "polkadot-api";
import { TOKENS } from "@getsome/core";

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  /** Pallet-assets holdings on Asset Hub, by `${assetId}:${ss58}`. */
  holdings: new Map<string, bigint>(),
  /** The PSM's debt against USDT: the room for a redeem. */
  psmDebt: 0n,
  /** The transactions the key signed on Asset Hub. */
  submits: [] as { pallet: string; name: string; args: unknown; options: unknown }[],
}));

vi.mock("../worker/src/host.js", () => ({
  deriveEntropy: vi.fn(),
  getHostProvider: vi.fn(),
  getHostLocalStorage: async () => ({
    readJSON: async (key: string) => mocks.stored.get(key) ?? null,
    writeJSON: async (key: string, value: unknown) => {
      mocks.stored.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

vi.mock("../worker/src/providers.js", () => ({ PAY_TIMEOUT_MS: 300_000, railFor: vi.fn() }));

// How the CASH moves to Asset Hub is the chains' answer; the XCM has left already here.
vi.mock("@getsome/funding", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chooseCashTransfer: async () => "teleport",
}));

// Two chains, told apart by what the engine asks for: People holds nothing of the key's any
// more; Asset Hub holds its CASH, prices the exit's fee, has room in the PSM and a pool at a
// fixed rate, and takes whatever the key signs.
vi.mock("../worker/src/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/src/shared.js")>();
  const assetHubTx = (pallet: string, name: string) => (args: unknown) => ({
    decodedCall: { type: pallet, value: { type: name, value: args } },
    getEstimatedFees: async () => 10_000_000n,
    signAndSubmit: async (_signer: unknown, options: unknown) => {
      mocks.submits.push({ pallet, name, args, options });
      return { ok: true, txHash: "0x1", block: { number: 7 } };
    },
  });
  const assetHubApi = {
    tx: {
      Psm: { redeem: assetHubTx("Psm", "redeem") },
      Assets: { transfer_all: assetHubTx("Assets", "transfer_all") },
      Utility: { batch_all: assetHubTx("Utility", "batch_all") },
      AssetConversion: {
        swap_exact_tokens_for_tokens: assetHubTx("AssetConversion", "swap_exact_tokens_for_tokens"),
      },
    },
    query: {
      Psm: {
        PsmDebt: { getValue: async () => mocks.psmDebt },
        Psm: { getValue: async () => ({ min_swap_amount: 1_000_000n }) },
      },
      Assets: {
        Asset: {
          getValue: async (id: number) => ({ min_balance: id === 1984 ? 70_000n : 1n }),
        },
        Account: {
          getValue: async (id: number, address: string) => {
            const balance = mocks.holdings.get(`${id}:${address}`);
            return balance === undefined ? undefined : { balance };
          },
        },
      },
    },
    apis: {
      AssetConversionApi: {
        // CASH, local to Asset Hub, sells for ten thousand times its units in the native's;
        // the native sells for a stable at 0.38 per CASH it came from.
        quote_price_exact_tokens_for_tokens: async (
          give: { parents: number },
          _want: unknown,
          amountIn: bigint,
        ) => (give.parents === 0 ? amountIn * 10_000n : ((amountIn / 10_000n) * 38n) / 100n),
        // The exit's dispatch fee, priced in CASH.
        quote_price_tokens_for_exact_tokens: async () => 3_251n,
      },
      DryRunApi: {
        dry_run_call: async () => ({
          success: true,
          value: { execution_result: { success: true, value: {} } },
        }),
      },
    },
  };
  const peopleApi = {
    query: {
      Assets: { Account: { getValue: async () => ({ balance: 0n }) } },
      System: { Account: { getValue: async () => ({ data: { free: 0n } }) } },
    },
  };
  return {
    ...actual,
    keypairFor: async () => ({ address: "5Key", signer: {} }),
    connectChain: async (_genesis: string, what: string) => ({
      getBestBlocks: async () => [
        { hash: what === "asset hub" ? "0xah-best" : "0xpeople-best", number: 1 },
      ],
      getTypedApi: () => (what === "asset hub" ? assetHubApi : peopleApi),
      destroy: () => {},
    }),
  };
});

vi.mock("@polkadot-api/descriptors", () => ({
  paseo_next_v2: { fake: "asset-hub" },
  paseo_people_next: { fake: "people" },
}));

vi.mock("@getsome/people", () => ({ CASH_LOCATION: { fake: "cash" } }));

type Engine = typeof import("../worker/src/withdraw-engine.js");
type StoredJob = Record<string, any>;

const WITHDRAW_KEY = "getsome.withdraw.jobs";
const hash32 = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(32)}`;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86_400_000;
const KEY_HEX = hash32(0x07);
const LANDING_HEX = hash32(0xaa);
const LANDING_SS58 = AccountId().dec(LANDING_HEX);
const KEY_SS58 = AccountId().dec(KEY_HEX);
const CASH_ID = TOKENS.CASH.assetHubId;
const USDT_ID = TOKENS.USDT.assetHubId;

/** A PSM-tier withdrawal to a USDT address whose XCM has left People: the CASH is due on the
 *  key's own Asset Hub account, the redeem next. */
function convertingJob(exit?: "psm" | "pool"): StoredJob {
  return {
    v: 1,
    sessionId: "s-1",
    label: "wd:eph:usdt-assethub:1",
    keyAddress: "5Key",
    keyPublicKeyHex: KEY_HEX,
    amount: "10500000",
    destination: { chain: "Asset Hub", asset: "USDT", address: LANDING_SS58 },
    landingHex: LANDING_HEX,
    rail: "direct",
    tier: "psm",
    external: "USDT",
    feeRate: 5_000,
    assetHubGenesis: hash32(0x11),
    peopleGenesis: hash32(0x22),
    peopleParaId: 1004,
    assetHubParaId: 1000,
    poolAccount: "5Pool",
    slippagePct: 5,
    paymentExpiresAt: NOW + DAY,
    phase: "await-arrival",
    landed: false,
    done: false,
    createdAt: NOW - 60_000,
    armedAt: NOW - 60_000,
    lastTickAt: NOW - 10_000,
    state: {
      attempts: 2,
      rejections: 0,
      submitted: true,
      destinationBefore: null,
      expectedLanding: null,
      fundsSeenAt: NOW - 60_000,
      psmRefusals: 0,
      waitingSince: null,
      ...(exit === undefined ? {} : { exit }),
      workedMs: 0,
    },
    leg: { handoff: null, paid: false, sweep: { attempts: 0, rejections: 0 }, reading: null },
    txs: [],
  };
}

async function engineWith(job: StoredJob): Promise<Engine> {
  mocks.stored.set(WITHDRAW_KEY, { "s-1": job });
  vi.resetModules();
  return await import("../worker/src/withdraw-engine.js");
}

const storedJob = (): StoredJob =>
  (mocks.stored.get(WITHDRAW_KEY) as Record<string, StoredJob>)["s-1"]!;

const hold = (id: number, ss58: string, balance: bigint) =>
  mocks.holdings.set(`${id}:${ss58}`, balance);

/** The exit's options: the fee in CASH, anchored on Asset Hub. */
const EXIT_OPTIONS = { asset: TOKENS.CASH.location, at: "0xah-best" };
/** What 10 CASH on the key leaves for the exit once the fee's margin (3,577) and the account's
 *  minimum (1) stay behind. */
const CASH_IN = 9_996_422n;

describe("the worker's redeem step", () => {
  beforeEach(() => {
    mocks.stored.clear();
    mocks.holdings.clear();
    mocks.submits.length = 0;
    mocks.psmDebt = 500_000_000n;
    hold(CASH_ID, KEY_SS58, 10_000_000n);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redeems the CASH on the key through the PSM, signed with Asset Hub's anchor, and reads the landing", async () => {
    const engine = await engineWith(convertingJob());
    await engine.tickAllWithdraw();
    expect(mocks.submits).toEqual([
      {
        pallet: "Utility",
        name: "batch_all",
        args: {
          calls: [
            {
              type: "Psm",
              value: {
                type: "redeem",
                value: {
                  internal_asset: TOKENS.CASH.location,
                  external_asset: TOKENS.USDT.location,
                  internal_amount: CASH_IN,
                  max_fee: 5_000,
                },
              },
            },
            {
              type: "Assets",
              value: {
                type: "transfer_all",
                value: {
                  id: USDT_ID,
                  dest: { type: "Id", value: LANDING_SS58 },
                  keep_alive: false,
                },
              },
            },
          ],
        },
        options: EXIT_OPTIONS,
      },
    ]);
    expect(storedJob()).toMatchObject({
      phase: "redeem",
      landed: false,
      done: false,
      state: {
        attempts: 3,
        exit: "psm",
        redeemSubmitted: true,
        destinationBefore: "0",
        expectedLanding: "9946439",
        waitingSince: null,
      },
      txs: [{ call: "redeem", txHash: "0x1", block: 7 }],
    });

    // The redeem landed: the key keeps its dust, the destination has the net.
    hold(CASH_ID, KEY_SS58, 327n);
    hold(USDT_ID, LANDING_SS58, 9_946_439n);
    await engine.tickAllWithdraw();
    expect(mocks.submits).toHaveLength(1);
    expect(storedJob()).toMatchObject({ phase: "done", landed: true, done: true });
  });

  it("sells the CASH on the pool from the same step once the user chose it", async () => {
    const engine = await engineWith(convertingJob("pool"));
    await engine.tickAllWithdraw();
    expect(mocks.submits).toEqual([
      {
        pallet: "AssetConversion",
        name: "swap_exact_tokens_for_tokens",
        args: {
          path: [TOKENS.CASH.location, TOKENS.PAS.location, TOKENS.USDT.location],
          amount_in: CASH_IN,
          amount_out_min: 3_608_708n,
          send_to: LANDING_SS58,
          keep_alive: false,
        },
        options: EXIT_OPTIONS,
      },
    ]);
    expect(storedJob()).toMatchObject({
      phase: "redeem",
      state: { exit: "pool", redeemSubmitted: true, expectedLanding: "3608708" },
      txs: [{ call: "pool-exit", txHash: "0x1", block: 7 }],
    });
  });
});
