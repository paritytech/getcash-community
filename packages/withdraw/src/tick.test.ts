// Offline coverage over a scripted People and Asset Hub: the two transactions in order, the fee
// measurement converging on an exact allowance, the CASH leaving to the unit, arrival by the
// destination's balance, and every refusal.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { amountOut } from "@getsome/funding";
import { saleBounds, swapHeadroomPct, XCM_TX_FEE_HEADROOM_PCT } from "./fees";
import { PASEO_PEOPLE_POOL_ACCOUNT } from "./paseo";
import { cashInFor } from "./pool";
import {
  freshWithdrawTickState,
  landingFloor,
  MAX_REJECTIONS,
  withdrawTickOnce,
  WithdrawRejectedError,
  type WithdrawStep,
  type WithdrawTickInput,
  type WithdrawTickState,
} from "./tick";

const ED = 1_000_000_000n; // 0.1 PAS
const RESERVES = { cash: 4_004_853_413n, pas: 9_987_917_550_000n };
/** What People charged the swap in CASH on Paseo: the pre-charge less the refund. */
const SWAP_FEE_CASH = 16_031n - 18n;
/** What People charges the XCM transaction in PAS, and the reserve the sizing keeps for it. */
const XCM_TX_FEE_PAS = 39_580_000n;
const RESERVE = (XCM_TX_FEE_PAS * BigInt(100 + XCM_TX_FEE_HEADROOM_PCT)) / 100n;
/** What People charges the XCM's execution: a small local part plus a delivery part that grows
 *  with the number of assets the forwarded message carries. */
const LOCAL = 410_000n;
const DELIVERY = { 1: 318_000_000n, 2: 319_700_000n } as const;
const WEIGHED = { ref_time: 2_358_560_232n, proof_size: 61_000n };
/** Asset Hub's sale price: planck per CASH unit. */
const AH_RATE = 3_780n;
const KEY_CASH = 20_999_683n;
const KEY = { address: "5Key", publicKeyHex: `0x${"07".repeat(32)}`, signer: {} as never };
const DESTINATION = new Uint8Array(32).fill(0xaa);
const DESTINATION_HEX = `0x${"aa".repeat(32)}`;
const DESTINATION_SS58 = AccountId(42).dec(DESTINATION);
/** What the destination holds before any withdrawal reaches it. */
const DESTINATION_PAS = 3n * ED;

type Instruction = { type: string; value?: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type Message = { type: string; value: Instruction[] };
type ExecuteArgs = { message: Message; max_weight: unknown };
type SwapArgs = { amount_out: bigint; amount_in_max: bigint };
type Submit = { call: string; args: unknown; options: Record<string, unknown> };

const incomplete = (index: number, error: string) => ({
  type: "Module",
  value: {
    type: "PolkadotXcm",
    value: { type: "LocalExecutionIncompleteWithError", value: { index, error: { type: error } } },
  },
});
const moduleError = (pallet: string, variant: string) => ({
  type: "Module",
  value: { type: pallet, value: { type: variant } },
});
const trappedEvent = (amount: bigint) => ({
  type: "PolkadotXcm",
  value: {
    type: "AssetsTrapped",
    value: { assets: { type: "V5", value: [{ fun: { type: "Fungible", value: amount } }] } },
  },
});
const rejectedExecution = (error: unknown) => ({
  success: true,
  value: {
    execution_result: { success: false, value: { error } },
    emitted_events: [],
    forwarded_xcms: [],
  },
});

/** Scripted People and Asset Hub. The pool, the fees and the dry runs answer as the live chains
 *  did in the probes; the switches script the failures. */
function scriptedWorld(
  opts: {
    /** The destination shows the PAS after this many reads following the XCM. */
    arrivalAfterReads?: number;
    /** Asset Hub credits this much less than its dry run said. */
    landShort?: bigint;
    /** People rejects the XCM at inclusion with this XCM error. */
    rejectXcm?: string;
    /** The XCM lands but the submit's answer never comes back. */
    loseXcmAnswer?: boolean;
    /** Asset Hub's dry run traps this much. */
    trapOnAssetHubDryRun?: bigint;
    /** A readable CASH/PAS pool on Asset Hub, so the sizing derives its bound from it. */
    pool?: { cash: bigint; pas: bigint };
    /** CASH other people sold into that pool after the finalized head, visible only at best. */
    soldAheadAtBest?: bigint;
  } = {},
) {
  const state = {
    keyCash: KEY_CASH,
    keyPas: 0n,
    dustLost: 0n,
    submits: [] as Submit[],
    dryRuns: 0,
    destinationPas: DESTINATION_PAS,
    /** What the last Asset Hub dry run credited to the destination. */
    lastDryRunLanded: 0n,
    xcmLanded: false,
    pasLanded: false,
    destinationReads: 0,
  };

  const payFeesOf = (message: Message) =>
    (message.value[1]!.value as { asset: Fungible }).asset.fun.value;
  const withdrawnOf = (message: Message) => message.value[0]!.value as Fungible[];
  const assetsCount = (message: Message) => (message.value[2]!.value as Fungible[]).length;

  /** What People forwards for an XCM whose allowance leaves `pasLeft`. */
  function forwardedFor(message: Message): Message {
    const [pasWithdrawn, cashWithdrawn] = withdrawnOf(message);
    const pasLeft = pasWithdrawn!.fun.value - payFeesOf(message);
    const transfer = message.value[2]!.value as {
      remote_fees: { value: { value: Fungible[] } };
      remote_xcm: Instruction[];
    };
    const earmark = transfer.remote_fees.value.value[0]!;
    return {
      type: "V5",
      value: [
        { type: "ReceiveTeleportedAsset", value: [earmark] },
        { type: "PayFees", value: { asset: earmark } },
        {
          type: "ReceiveTeleportedAsset",
          value:
            pasLeft > 0n
              ? [{ ...pasWithdrawn!, fun: { type: "Fungible", value: pasLeft } }, cashWithdrawn!]
              : [cashWithdrawn!],
        },
        { type: "ClearOrigin" },
        ...transfer.remote_xcm,
        { type: "SetTopic", value: `0x${"00".repeat(32)}` },
      ],
    };
  }

  const txHashFor = () => `0x${state.submits.length.toString(16).padStart(64, "0")}`;

  /** The swap as People runs it: the fee comes off the CASH first, then the pool sells the exact
   *  PAS for what its reserves ask, within the cap. */
  const swapTx = (args: SwapArgs) => ({
    decodedCall: { type: "AssetConversion", value: { type: "swap", value: args } },
    signAndSubmit: async (_signer: unknown, options: Record<string, unknown>) => {
      state.submits.push({ call: "swap", args, options });
      state.keyCash -= SWAP_FEE_CASH;
      const cashIn = cashInFor(args.amount_out, RESERVES);
      if (cashIn > args.amount_in_max) {
        return {
          ok: false,
          txHash: txHashFor(),
          dispatchError: moduleError("AssetConversion", "ProvidedMaximumNotSufficientForSwap"),
          events: [],
        };
      }
      state.keyCash -= cashIn;
      state.keyPas += args.amount_out;
      return { ok: true, txHash: txHashFor(), block: { number: 499 }, events: [] };
    },
  });

  /** The XCM as People runs it: the pool refuses it unless the fee leaves the existential deposit
   *  in place, the fee comes off the PAS first, WithdrawAsset needs both amounts on the key, and
   *  the allowance must cover the charge for the message actually forwarded. */
  const executeTx = (args: ExecuteArgs) => ({
    decodedCall: { type: "PolkadotXcm", value: { type: "execute", value: args } },
    getEstimatedFees: async () => XCM_TX_FEE_PAS,
    signAndSubmit: async (_signer: unknown, options: Record<string, unknown>) => {
      state.submits.push({ call: "execute", args, options });
      if (state.keyPas - XCM_TX_FEE_PAS < ED) {
        throw new Error(JSON.stringify({ type: "Invalid", value: { type: "Payment" } }));
      }
      state.keyPas -= XCM_TX_FEE_PAS;
      const [pasWithdrawn, cashWithdrawn] = withdrawnOf(args.message);
      const short =
        pasWithdrawn!.fun.value > state.keyPas || cashWithdrawn!.fun.value > state.keyCash;
      if (short || opts.rejectXcm) {
        return {
          ok: false,
          txHash: txHashFor(),
          dispatchError: incomplete(
            short ? 0 : 2,
            short ? "FailedToTransactAsset" : opts.rejectXcm!,
          ),
          events: [],
        };
      }
      state.keyCash -= cashWithdrawn!.fun.value;
      state.keyPas -= pasWithdrawn!.fun.value;
      // Below the existential deposit the account is reaped and its PAS is dust.
      if (state.keyPas < ED) {
        state.dustLost += state.keyPas;
        state.keyPas = 0n;
      }
      state.xcmLanded = true;
      if (opts.loseXcmAnswer) throw new Error("withdrawal submit timed out after 1s");
      return { ok: true, txHash: txHashFor(), block: { number: 500 }, events: [] };
    },
  });

  const peopleApi = {
    constants: { Balances: { ExistentialDeposit: async () => ED } },
    query: {
      System: {
        Account: {
          getValue: async (who: string) => ({
            data: { free: who === PASEO_PEOPLE_POOL_ACCOUNT ? RESERVES.pas : state.keyPas },
          }),
        },
      },
      Assets: {
        Account: {
          getValue: async (_asset: unknown, who: string) => ({
            balance: who === PASEO_PEOPLE_POOL_ACCOUNT ? RESERVES.cash : state.keyCash,
          }),
        },
      },
    },
    apis: {
      XcmPaymentApi: {
        query_xcm_weight: async () => ({ success: true, value: WEIGHED }),
        query_delivery_fees: async (_dest: unknown, message: Message) => ({
          success: true,
          value: {
            type: "V5",
            value: [{ fun: { type: "Fungible", value: DELIVERY[assetsCount(message) as 1 | 2] } }],
          },
        }),
      },
      DryRunApi: {
        // No fee is charged in a dry run; the withdrawn amounts must be on the key and the
        // unspent allowance is trapped.
        dry_run_call: async (_origin: unknown, call: { value: { value: ExecuteArgs } }) => {
          state.dryRuns += 1;
          const message = call.value.value.message;
          const [pasWithdrawn, cashWithdrawn] = withdrawnOf(message);
          if (pasWithdrawn!.fun.value > state.keyPas || cashWithdrawn!.fun.value > state.keyCash) {
            return rejectedExecution(incomplete(0, "FailedToTransactAsset"));
          }
          const forwarded = forwardedFor(message);
          const charge = LOCAL + DELIVERY[assetsCount(forwarded) as 1 | 2];
          const payFees = payFeesOf(message);
          if (payFees < charge) return rejectedExecution(incomplete(2, "NotHoldingFees"));
          const surplus = payFees - charge;
          return {
            success: true,
            value: {
              execution_result: { success: true, value: {} },
              emitted_events: surplus > 0n ? [trappedEvent(surplus)] : [],
              forwarded_xcms: [
                [
                  {
                    type: "V5",
                    value: {
                      parents: 1,
                      interior: { type: "X1", value: { type: "Parachain", value: 1500 } },
                    },
                  },
                  [forwarded],
                ],
              ],
            },
          };
        },
      },
    },
    tx: {
      AssetConversion: { swap_tokens_for_exact_tokens: swapTx },
      PolkadotXcm: { execute: executeTx },
    },
  };

  /** PAS the sale returns, after the sales ahead of it when read at best. No pool, a flat rate. */
  const pool = opts.pool;
  const reservesAt = (at?: string) => {
    const reserves = { in: pool!.cash, out: pool!.pas };
    const ahead = at === "best" ? (opts.soldAheadAtBest ?? 0n) : 0n;
    if (ahead <= 0n) return reserves;
    const got = amountOut(ahead, reserves, 3_000n) ?? 0n;
    return { in: reserves.in + ahead, out: reserves.out - got };
  };
  const sell = (cashIn: bigint, at?: string) =>
    pool === undefined ? cashIn * AH_RATE : (amountOut(cashIn, reservesAt(at), 3_000n) ?? 0n);

  const assetHubApi = {
    ...(pool === undefined
      ? {}
      : {
          // Asked native-first, answered in the order asked, as the pallet does.
          view: {
            AssetConversion: {
              get_reserves: async (_a: unknown, _b: unknown, options?: { at?: string }) => {
                const r = reservesAt(options?.at);
                return [r.out, r.in];
              },
            },
          },
          constants: { AssetConversion: { LPFee: async () => 3_000 } },
        }),
    apis: {
      AssetConversionApi: {
        quote_price_exact_tokens_for_tokens: async (
          _a: unknown,
          _b: unknown,
          cashIn: bigint,
          _includeFee?: boolean,
          options?: { at?: string },
        ) => sell(cashIn, options?.at),
      },
      DryRunApi: {
        // Asset Hub sells every CASH it receives and deposits all the PAS to the destination.
        dry_run_xcm: async (_origin: unknown, forwarded: Message, options?: { at?: string }) => {
          const travelling = forwarded.value[2]!.value as Fungible[];
          const earmark = (forwarded.value[0]!.value as Fungible[])[0]!.fun.value;
          const pas = travelling.length === 2 ? travelling[0]!.fun.value : 0n;
          const cash = travelling[travelling.length - 1]!.fun.value + earmark - 3_546n;
          state.lastDryRunLanded = pas + sell(cash, options?.at);
          const events: unknown[] = [
            {
              type: "Balances",
              value: {
                type: "Deposit",
                value: { who: DESTINATION_SS58, amount: pas + sell(cash, options?.at) },
              },
            },
          ];
          if (opts.trapOnAssetHubDryRun) events.push(trappedEvent(opts.trapOnAssetHubDryRun));
          return {
            success: true,
            value: {
              execution_result: { type: "Complete", value: { used: {} } },
              emitted_events: events,
            },
          };
        },
      },
    },
  };

  /** The destination's PAS at the head: the XCM's PAS shows after `arrivalAfterReads` reads. */
  const readDestinationOnAssetHub = async () => {
    if (state.xcmLanded && !state.pasLanded) {
      state.destinationReads += 1;
      if (state.destinationReads >= (opts.arrivalAfterReads ?? 1)) {
        state.destinationPas += state.lastDryRunLanded - (opts.landShort ?? 0n);
        state.pasLanded = true;
      }
    }
    return state.destinationPas;
  };

  return { state, peopleApi, assetHubApi, readDestinationOnAssetHub };
}

type World = ReturnType<typeof scriptedWorld>;

async function drive(
  world: World,
  ticks: number,
  state: WithdrawTickState = freshWithdrawTickState(),
  sizings: Array<{ promisePct: number; safetyPct: number; overCapacity: boolean }> = [],
  extra: Partial<WithdrawTickInput> = {},
) {
  const steps: WithdrawStep[] = [];
  const transients: string[] = [];
  let now = 1_000;
  for (let tick = 0; tick < ticks; tick += 1) {
    now += 1_000;
    const outcome = await withdrawTickOnce(
      {
        peopleApi: world.peopleApi as never,
        assetHubApi: world.assetHubApi as never,
        key: KEY,
        destinationHex: DESTINATION_HEX,
        assetHubParaId: 1500,
        peopleParaId: 1502,
        poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
        slippagePct: 5,
        tickTimeoutMs: 1_000,
        submitTimeoutMs: 1_000,
        readKeyOnPeople: async () => ({ cash: world.state.keyCash, pas: world.state.keyPas }),
        readDestinationOnAssetHub: world.readDestinationOnAssetHub,
        now: () => now,
        onTransientError: (e) => transients.push(e instanceof Error ? e.message : String(e)),
        onSizing: (info) => sizings.push(info),
        ...extra,
      },
      state,
    );
    steps.push(outcome.step);
    if (outcome.step === "done") break;
  }
  return { steps, state, transients };
}

const submitsOf = (world: World) => ({
  swap: world.state.submits.find((s) => s.call === "swap"),
  execute: world.state.submits.find((s) => s.call === "execute"),
});

describe("withdrawTickOnce", () => {
  it("waits for CASH, swaps, then sizes, proves and submits the XCM, then reads the destination to done", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 2 });
    world.state.keyCash = 0n;
    const idle = await drive(world, 1);
    expect(idle.steps).toEqual(["await-cash"]);
    expect(idle.state.fundsSeenAt).toBeNull();

    world.state.keyCash = KEY_CASH;
    const run = await drive(world, 6, idle.state);
    expect(run.steps).toEqual(["swap", "convert", "await-arrival", "done"]);
    expect(run.state).toMatchObject({
      attempts: 2,
      rejections: 0,
      submitted: true,
      // The baseline is what the destination held before the XCM; the landing is the dry run's.
      destinationPasBefore: DESTINATION_PAS,
      expectedLanding: world.state.lastDryRunLanded,
    });
    expect(run.state.fundsSeenAt).toBe(2_000);
    expect(run.transients).toEqual([]);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + world.state.lastDryRunLanded);
  });

  it("keeps waiting while the destination gained less than the landing floor", async () => {
    const world = scriptedWorld({ landShort: 20_000_000_000n });
    const run = await drive(world, 4);
    expect(run.steps).toEqual(["swap", "convert", "await-arrival", "await-arrival"]);
    expect(landingFloor(100n, 5)).toBe(95n);
    expect(landingFloor(1_000n, 0.5)).toBe(995n);
  });

  it("leaves no CASH: the XCM withdraws the whole balance read after the swap, and only PAS dust stays", async () => {
    const world = scriptedWorld();
    await drive(world, 2);
    const { swap, execute } = submitsOf(world);
    const swapArgs = swap!.args as SwapArgs;
    const message = (execute!.args as ExecuteArgs).message;
    const [pasWithdrawn, cashWithdrawn] = message.value[0]!.value as Fungible[];
    const payFees = (message.value[1]!.value as { asset: Fungible }).asset.fun.value;

    // The swap buys the existential deposit plus the XCM's fee reserve, allowed to spend a little
    // over the quote.
    expect(swapArgs.amount_out).toBe(ED + RESERVE);
    expect(swapArgs.amount_in_max).toBe(
      (cashInFor(ED + RESERVE, RESERVES) *
        BigInt(Math.round((100 + swapHeadroomPct(RESERVES, ED + RESERVE)) * 100))) /
        10_000n,
    );
    // The XCM took every CASH left after the swap and its fee.
    expect(cashWithdrawn!.fun.value).toBe(
      KEY_CASH - SWAP_FEE_CASH - cashInFor(ED + RESERVE, RESERVES),
    );
    expect(world.state.keyCash).toBe(0n);
    // And all the PAS but the reserve, whose unspent part is the only dust, reaped with the key.
    expect(pasWithdrawn!.fun.value).toBe(ED);
    expect(world.state.keyPas).toBe(0n);
    expect(world.state.dustLost).toBe(RESERVE - XCM_TX_FEE_PAS);
    expect(world.state.dustLost).toBeLessThan(ED);
    // Exactly what People charges for the two-asset message, no more.
    expect(payFees).toBe(LOCAL + DELIVERY[2]);
    // The weight ceiling is the weighed weight, so nothing is refunded after the key is emptied.
    expect((execute!.args as ExecuteArgs).max_weight).toEqual(WEIGHED);
  });

  it("pays the swap in CASH and the XCM in PAS, both with People's signed extension", async () => {
    const world = scriptedWorld();
    await drive(world, 2);
    const { swap, execute } = submitsOf(world);
    const extension = { VerifyMultiSignature: { value: { type: "Disabled" } } };
    expect(swap!.options).toMatchObject({
      asset: expect.anything(),
      customSignedExtensions: extension,
    });
    expect(execute!.options).toMatchObject({ customSignedExtensions: extension });
    expect(execute!.options).not.toHaveProperty("asset");
  });

  it("swaps again when the PAS on the key cannot pay the XCM's fee and keep the deposit", async () => {
    const world = scriptedWorld();
    // The existential deposit alone: the pool would refuse the fee charge.
    world.state.keyPas = ED;
    const run = await drive(world, 3);
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    expect(run.transients[0]).toMatch(/the key holds .* PAS and the XCM needs/);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);
    expect(world.state.keyCash).toBe(0n);
    expect(world.state.keyPas).toBe(0n);
  });

  it("names the failing instruction on a rejected XCM, retries with fresh sizing, and gives up after the cap", async () => {
    const world = scriptedWorld({ rejectXcm: "NoDeal" });
    // Enough PAS that no rejection sends the run back to the swap.
    world.state.keyPas = 3n * ED;
    const state = freshWithdrawTickState();
    for (let rejection = 1; rejection < MAX_REJECTIONS; rejection += 1) {
      await expect(drive(world, 1, state)).rejects.toThrow(
        /withdraw rejected: InitiateTransfer failed with NoDeal/,
      );
      expect(state).toMatchObject({ rejections: rejection, submitted: false });
    }
    await expect(drive(world, 1, state)).rejects.toBeInstanceOf(WithdrawRejectedError);
    expect(state.attempts).toBe(MAX_REJECTIONS);
    // Each rejection cost the transaction fee in PAS; the CASH never moved.
    expect(world.state.keyPas).toBe(3n * ED - BigInt(MAX_REJECTIONS) * XCM_TX_FEE_PAS);
    expect(world.state.keyCash).toBe(KEY_CASH);
  });

  it("finishes when the XCM emptied the key but its answer was lost: the baseline read before the submit still measures the arrival", async () => {
    const world = scriptedWorld({ loseXcmAnswer: true });
    const state = freshWithdrawTickState();
    await drive(world, 1, state);
    await expect(drive(world, 1, state)).rejects.toThrow(/timed out/);
    expect(state).toMatchObject({
      attempts: 2,
      submitted: false,
      destinationPasBefore: DESTINATION_PAS,
      expectedLanding: world.state.lastDryRunLanded,
    });
    expect(world.state.keyCash).toBe(0n);
    // An empty key after a submit is not an unpaid key; the next tick reads the destination.
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "done"]);
    expect(state.submitted).toBe(true);
  });

  it("holds in await-arrival when the baseline was lost with the state", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state);
    state.destinationPasBefore = null;
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "await-arrival"]);
    expect(world.state.destinationReads).toBe(0);
  });

  it("does not count a deposit from elsewhere as the arrival while the key still holds funds", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    state.submitted = true;
    state.fundsSeenAt = 1_000;
    state.destinationPasBefore = DESTINATION_PAS;
    state.expectedLanding = 5n * ED;
    // A stranger pays the destination while the key, unspent, still holds its CASH.
    world.state.destinationPas = DESTINATION_PAS + 5n * ED;
    const waiting = await drive(world, 1, state);
    expect(waiting.steps).toEqual(["await-arrival"]);
    // The XCM took the CASH; PAS dust the reaping missed does not hold the run.
    world.state.keyCash = 0n;
    world.state.keyPas = 1n;
    const done = await drive(world, 1, state);
    expect(done.steps).toEqual(["done"]);
  });

  it("refuses to submit the XCM when the Asset Hub dry run would trap assets", async () => {
    const world = scriptedWorld({ trapOnAssetHubDryRun: 7n });
    const state = freshWithdrawTickState();
    await drive(world, 1, state);
    await expect(drive(world, 1, state)).rejects.toThrow(/would trap 7 on Asset Hub/);
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap"]);
    expect(world.state.keyPas).toBe(ED + RESERVE);
  });
});

describe("withdrawTickOnce after a submit whose answer was lost", () => {
  it("keeps the first baseline when a stale People view makes it size again", async () => {
    // People is read at finalized and Asset Hub at best, so after a lost answer People can still
    // show the key funded while the destination holds the landing. A new baseline would hide it.
    const world = scriptedWorld({ loseXcmAnswer: true });
    const state = freshWithdrawTickState();
    let stale: { cash: bigint; pas: bigint } | null = null;
    const dryRun = world.peopleApi.apis.DryRunApi.dry_run_call;
    world.peopleApi.apis.DryRunApi.dry_run_call = (async (...args: Parameters<typeof dryRun>) => {
      if (stale === null) return dryRun(...args);
      const live = { cash: world.state.keyCash, pas: world.state.keyPas };
      world.state.keyCash = stale.cash;
      world.state.keyPas = stale.pas;
      try {
        return await dryRun(...args);
      } finally {
        world.state.keyCash = live.cash;
        world.state.keyPas = live.pas;
      }
    }) as typeof dryRun;
    const tick = async () => {
      try {
        const out = await withdrawTickOnce(
          {
            peopleApi: world.peopleApi as never,
            assetHubApi: world.assetHubApi as never,
            key: KEY,
            destinationHex: DESTINATION_HEX,
            assetHubParaId: 1500,
            peopleParaId: 1502,
            poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
            slippagePct: 5,
            tickTimeoutMs: 1_000,
            submitTimeoutMs: 1_000,
            readKeyOnPeople: async () =>
              stale ?? { cash: world.state.keyCash, pas: world.state.keyPas },
            readDestinationOnAssetHub: world.readDestinationOnAssetHub,
            now: () => 5_000,
          },
          state,
        );
        return out.step;
      } catch {
        return "threw";
      }
    };

    expect(await tick()).toBe("swap");
    const funded = { cash: world.state.keyCash, pas: world.state.keyPas };
    expect(await tick()).toBe("threw"); // the XCM runs on People, its answer is lost
    const firstBaseline = state.destinationPasBefore;
    stale = funded; // People's finalized head still shows the key funded
    await tick(); // sizes again and reads the destination, which already holds the landing
    expect(state.destinationPasBefore).toBe(firstBaseline);
    stale = null; // People finalizes
    const steps: string[] = [];
    for (let i = 0; i < 4; i += 1) steps.push(await tick());
    expect(steps).toContain("done");
  });
});

describe("withdrawTickOnce after an XCM attempt that can no longer land", () => {
  // Such an attempt must drop its baseline, or a stranger's credit counts as the next attempt's
  // arrival, here one that traps on Asset Hub and lands nothing.
  const STRANGER = 100n * ED;

  it("drops the baseline of an XCM rejected at inclusion", async () => {
    const opts: { rejectXcm?: string } = { rejectXcm: "NoDeal" };
    const world = scriptedWorld(opts);
    // Enough PAS that the rejection does not send the run back to the swap.
    world.state.keyPas = 3n * ED;
    const state = freshWithdrawTickState();
    await expect(drive(world, 1, state)).rejects.toThrow(/withdraw rejected/);
    expect(state.destinationPasBefore).toBeNull();
    delete opts.rejectXcm;
    world.state.destinationPas += STRANGER;
    world.state.pasLanded = true; // the next XCM traps on Asset Hub
    const run = await drive(world, 4, state);
    expect(run.steps[0]).toBe("convert");
    expect(run.steps).not.toContain("done");
  });

  /** The first XCM submit's answer is lost and the transaction never ran. */
  const dropFirstXcm = (world: World) => {
    let drop = true;
    const execute = world.peopleApi.tx.PolkadotXcm.execute;
    world.peopleApi.tx.PolkadotXcm.execute = ((args: ExecuteArgs) => {
      const tx = execute(args);
      return {
        ...tx,
        signAndSubmit: async (...submit: Parameters<typeof tx.signAndSubmit>) => {
          if (!drop) return tx.signAndSubmit(...submit);
          drop = false;
          throw new Error("withdrawal submit timed out after 1s");
        },
      };
    }) as typeof execute;
  };

  it("measures from the fresh baseline once a later XCM is included after a lost answer", async () => {
    // A later included XCM proves the lost one never ran, or the key could not pay its fee.
    const world = scriptedWorld();
    world.state.keyPas = 3n * ED;
    dropFirstXcm(world);
    const state = freshWithdrawTickState();
    await expect(drive(world, 1, state)).rejects.toThrow(/timed out/);
    expect(state.destinationPasBefore).toBe(DESTINATION_PAS);
    world.state.destinationPas += STRANGER;
    world.state.pasLanded = true; // the next XCM traps on Asset Hub
    const run = await drive(world, 4, state);
    expect(run.steps[0]).toBe("convert");
    expect(run.steps).not.toContain("done");
  });

  it("drops a lost answer's baseline when a later XCM is rejected at inclusion", async () => {
    const opts: { rejectXcm?: string } = {};
    const world = scriptedWorld(opts);
    world.state.keyPas = 3n * ED;
    dropFirstXcm(world);
    const state = freshWithdrawTickState();
    await expect(drive(world, 1, state)).rejects.toThrow(/timed out/);
    world.state.destinationPas += STRANGER;
    opts.rejectXcm = "NoDeal";
    await expect(drive(world, 1, state)).rejects.toThrow(/withdraw rejected/);
    expect(state.destinationPasBefore).toBeNull();
    delete opts.rejectXcm;
    world.state.pasLanded = true;
    const run = await drive(world, 4, state);
    expect(run.steps[0]).toBe("convert");
    expect(run.steps).not.toContain("done");
  });

  it("drops the baseline when the driver stops the submit before the broadcast", async () => {
    const world = scriptedWorld();
    world.state.keyPas = 3n * ED;
    const state = freshWithdrawTickState();
    const stopOnce = {
      onBeforeSubmit: () => {
        throw new Error("cancelled before the submit");
      },
    };
    await expect(drive(world, 1, state, [], stopOnce)).rejects.toThrow(/cancelled/);
    expect(state.destinationPasBefore).toBeNull();
    expect(world.state.submits).toHaveLength(0);
    world.state.destinationPas += STRANGER;
    world.state.pasLanded = true;
    const run = await drive(world, 4, state);
    expect(run.steps[0]).toBe("convert");
    expect(run.steps).not.toContain("done");
  });
});

describe("withdrawTickOnce on a readable Asset Hub pool", () => {
  // With a pool to read, the bound comes from it instead of the caller's 5% ceiling.

  /** The live Asset Hub pool, and the same price at the 2.5M CASH release depth. */
  const LIVE = { cash: 103_995_356_467n, pas: 421_298_658_123_227n };
  const RELEASE = { cash: LIVE.cash * 24n, pas: LIVE.pas * 24n };
  /** About 156k CASH, where the bound is neither at the 2% floor nor at the 5% ceiling. */
  const MID = { cash: (LIVE.cash * 3n) / 2n, pas: (LIVE.pas * 3n) / 2n };
  const CASH = (n: number) => BigInt(Math.round(n * 1e6));

  /** The CASH the XCM sold, read back out of the program that was submitted. */
  const soldBy = (world: World) => {
    const execute = submitsOf(world).execute!;
    const message = (execute.args as ExecuteArgs).message;
    return (message.value[0]!.value as Fungible[])[1]!.fun.value;
  };

  it("ships the derived bound on a deep pool, reports it, and keeps it for the arrival check", async () => {
    const world = scriptedWorld({ pool: RELEASE });
    const sizings: Array<{ promisePct: number; safetyPct: number; overCapacity: boolean }> = [];
    const run = await drive(world, 4, freshWithdrawTickState(), sizings);
    expect(run.steps.slice(0, 2)).toEqual(["swap", "convert"]);

    const cash = soldBy(world);
    const expected = saleBounds({
      reserves: { in: RELEASE.cash, out: RELEASE.pas },
      quoted: amountOut(cash, { in: RELEASE.cash, out: RELEASE.pas }, 3_000n)!,
      cashOnKey: cash,
      ceilingPct: 5,
      feePpm: 3_000n,
    });
    expect(sizings).toHaveLength(1);
    expect(sizings[0]).toEqual(expected);
    expect(sizings[0]!.safetyPct).toBeLessThan(5);
    expect(sizings[0]!.overCapacity).toBe(false);
    // The arrival check reads the bound the program carried, not the caller's ceiling.
    expect(run.state.submittedSlippagePct).toBe(expected.safetyPct);
  });

  it("checks the arrival against the bound the program carried, not the caller's ceiling", async () => {
    // The deep pool's bound is under 3%, so a landing 3% short waits though it clears 5%.
    const probe = scriptedWorld({ pool: RELEASE });
    await drive(probe, 4);
    const landed = probe.state.lastDryRunLanded;
    const world = scriptedWorld({ pool: RELEASE, landShort: (landed * 3n) / 100n });
    const sizings: Array<{ promisePct: number; safetyPct: number; overCapacity: boolean }> = [];
    const run = await drive(world, 5, freshWithdrawTickState(), sizings);
    expect(sizings[0]!.safetyPct).toBeLessThan(3);
    expect(run.steps).not.toContain("done");
    expect(run.steps.at(-1)).toBe("await-arrival");
  });

  it("ships the 5% ceiling on today's pool, which asks for more, and reports it over capacity", async () => {
    const world = scriptedWorld({ pool: LIVE });
    const sizings: Array<{ promisePct: number; safetyPct: number; overCapacity: boolean }> = [];
    await drive(world, 2, freshWithdrawTickState(), sizings);
    expect(sizings[0]).toEqual({ promisePct: 5, safetyPct: 5, overCapacity: true });
  });

  it("sizes at the best head: a sale executed after the finalized head is in the quote and the landing", async () => {
    // A quote at the finalized head misses the sales since, so both reads happen at best.
    const ahead = CASH(10_000);
    const world = scriptedWorld({ pool: MID, soldAheadAtBest: ahead });
    const sizings: Array<{ promisePct: number; safetyPct: number; overCapacity: boolean }> = [];
    const run = await drive(world, 4, freshWithdrawTickState(), sizings);
    expect(run.steps.slice(0, 2)).toEqual(["swap", "convert"]);

    const cash = soldBy(world);
    const pool = { in: MID.cash, out: MID.pas };
    const movedOut = amountOut(ahead, pool, 3_000n)!;
    const atBest = { in: pool.in + ahead, out: pool.out - movedOut };
    const boundAt = (reserves: typeof pool) =>
      saleBounds({
        reserves,
        quoted: amountOut(cash, reserves, 3_000n)!,
        cashOnKey: cash,
        ceilingPct: 5,
        feePpm: 3_000n,
      });
    // The reported bound comes from the best head, not the finalized one.
    expect(sizings).toEqual([boundAt(atBest)]);
    expect(boundAt(atBest)).not.toEqual(boundAt(pool));
    // So does the landing the arrival check is held to.
    expect(world.state.lastDryRunLanded).toBeLessThan(amountOut(cash, pool, 3_000n)!);
  });
});
