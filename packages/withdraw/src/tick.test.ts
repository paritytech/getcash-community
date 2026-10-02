// Offline coverage over a scripted People and Asset Hub: the two transactions in order, the fee
// measurement converging on an exact allowance, the CASH leaving to the unit, the sale per tier,
// arrival by the destination's balance in the landing asset, and every refusal.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { TOKENS } from "@getsome/core";
import { permillMulCeil, type ConversionRoute } from "@getsome/funding";
import {
  ASSET_HUB_FEE_BUFFER_CASH,
  estimateDirectFeesCash,
  SWAP_HEADROOM_PCT,
  XCM_TX_FEE_HEADROOM_PCT,
} from "./fees";
import { PASEO_PEOPLE_POOL_ACCOUNT } from "./paseo";
import { cashInFor } from "./pool";
import {
  freshWithdrawTickState,
  landingFloor,
  MAX_REJECTIONS,
  withdrawTickOnce,
  WithdrawRejectedError,
  type WithdrawStep,
  type WithdrawTickState,
} from "./tick";

const ED = 1_000_000_000n; // 0.1 PAS
const RESERVES = { cash: 4_004_853_413n, pas: 9_987_917_550_000n };
/** What People charged the swap in CASH on Paseo: the pre-charge less the refund. */
const SWAP_FEE_CASH = 16_031n - 18n;
/** The swap's fee as People estimates it, in PAS, before the charge is priced in CASH. */
const SWAP_TX_FEE_PAS = 40_000_000n;
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
/** The stable pools' price: planck per stable unit, one PAS to one USDC on a 10 to 6 decimal pair. */
const STABLE_PLANCK = 10_000n;
/** What the scripted Asset Hub charges the program in CASH. */
const AH_FEE_CASH = 3_546n;
const KEY_CASH = 20_999_683n;
const KEY = { address: "5Key", publicKeyHex: `0x${"07".repeat(32)}`, signer: {} as never };
const DESTINATION = new Uint8Array(32).fill(0xaa);
const DESTINATION_HEX = `0x${"aa".repeat(32)}`;
const DESTINATION_SS58 = AccountId(42).dec(DESTINATION);
/** What the destination holds before any withdrawal reaches it. */
const DESTINATION_PAS = 3n * ED;
/** The key's account under People as Asset Hub names it, and the redeem call encoded there. */
const HOLDER_SS58 = AccountId(42).dec(new Uint8Array(32).fill(0x0d));
const REDEEM_CALL = Uint8Array.from([0x3b, 0x01, 0xaa]);
const PSM_FEE_RATE = 5_000;

type Instruction = { type: string; value?: unknown };
type Fungible = { id: unknown; fun: { type: string; value: bigint } };
type Exchange = { want: Fungible[] };
type AssetLocation = { parents: number; interior: { value: Array<{ value: unknown }> } };
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
/** A hop that gives the native, which only the teleport tier's dust sale does first. */
const givesNative = (hop: Instruction | undefined) =>
  (hop?.value as { give: { value: { value: { id: { parents: number } } } } } | undefined)?.give
    .value.value.id.parents === 1;
/** Asset Hub crediting the destination: the native's Deposit, or a token's Deposited. */
const deposited = (assetId: number | null, amount: bigint) => ({
  type: assetId === null ? "Balances" : "Assets",
  value: {
    type: assetId === null ? "Deposit" : "Deposited",
    value: {
      ...(assetId === null ? {} : { asset_id: assetId }),
      who: DESTINATION_SS58,
      amount,
    },
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
    // The earmark comes out of the CASH withdrawn; the rest travels.
    const cashLeft = {
      ...cashWithdrawn!,
      fun: { type: "Fungible", value: cashWithdrawn!.fun.value - earmark.fun.value },
    };
    return {
      type: "V5",
      value: [
        { type: "ReceiveTeleportedAsset", value: [earmark] },
        { type: "PayFees", value: { asset: earmark } },
        {
          type: "ReceiveTeleportedAsset",
          value:
            pasLeft > 0n
              ? [{ ...pasWithdrawn!, fun: { type: "Fungible", value: pasLeft } }, cashLeft]
              : [cashLeft],
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
    getEstimatedFees: async () => SWAP_TX_FEE_PAS,
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

  const assetHubApi = {
    tx: { Psm: { redeem: () => ({ getEncodedData: async () => REDEEM_CALL }) } },
    apis: {
      LocationToAccountApi: {
        convert_location: async () => ({ success: true, value: HOLDER_SS58 }),
      },
      AssetConversionApi: {
        // CASH, local to Asset Hub, sells for the native; the native sells for a stable.
        quote_price_exact_tokens_for_tokens: async (
          give: { parents: number },
          _want: unknown,
          amountIn: bigint,
        ) => (give.parents === 0 ? amountIn * AH_RATE : amountIn / STABLE_PLANCK),
      },
      DryRunApi: {
        // Asset Hub runs the sale the program asks: every CASH for PAS on one hop, every PAS for
        // the stable on two, nothing sold on none; then deposits the holding to the destination.
        dry_run_xcm: async (_origin: unknown, forwarded: Message) => {
          const travelling = forwarded.value[2]!.value as Fungible[];
          const earmark = (forwarded.value[0]!.value as Fungible[])[0]!.fun.value;
          const pas = travelling.length === 2 ? travelling[0]!.fun.value : 0n;
          const cash = travelling[travelling.length - 1]!.fun.value + earmark - AH_FEE_CASH;
          const hops = forwarded.value.filter((i) => i.type === "ExchangeAsset");
          const native = pas + cash * AH_RATE;
          let events: unknown[];
          if (forwarded.value.some((i) => i.type === "Transact")) {
            // The PSM tier: the amount deposited to the holder is redeemed for what the program
            // withdraws back, and the surplus and the PAS are sold for the stable on top.
            const held = (
              forwarded.value.find((i) => i.type === "DepositAsset")!.value as {
                assets: { value: Fungible[] };
              }
            ).assets.value[0]!.fun.value;
            const out = (
              forwarded.value.find((i) => i.type === "WithdrawAsset")!.value as Fungible[]
            )[0]!.fun.value;
            state.lastDryRunLanded = out + ((cash - held) * AH_RATE + pas) / STABLE_PLANCK;
            events = [deposited(1984, state.lastDryRunLanded)];
          } else if (givesNative(hops[0])) {
            // The teleport tier: the PAS is sold for CASH and the CASH lands as dotUSD.
            state.lastDryRunLanded = cash + pas / AH_RATE;
            events = [deposited(TOKENS.CASH.assetHubId, state.lastDryRunLanded)];
          } else if (hops.length === 1) {
            state.lastDryRunLanded = native;
            events = [deposited(null, native)];
          } else {
            const want = (hops[1]!.value as Exchange).want[0]!.id as AssetLocation;
            state.lastDryRunLanded = native / STABLE_PLANCK;
            events = [deposited(Number(want.interior.value[1]!.value), state.lastDryRunLanded)];
          }
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

  /** The destination's balance in the landing asset at the head: what the XCM lands shows after
   *  `arrivalAfterReads` reads. */
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
  sale: ConversionRoute = { tier: "pool" },
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
        sale,
        slippagePct: 5,
        tickTimeoutMs: 1_000,
        submitTimeoutMs: 1_000,
        readKeyOnPeople: async () => ({ cash: world.state.keyCash, pas: world.state.keyPas }),
        readDestinationOnAssetHub: world.readDestinationOnAssetHub,
        now: () => now,
        onTransientError: (e) => transients.push(e instanceof Error ? e.message : String(e)),
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

/** The XCM that went out: the CASH it withdrew, its earmark, whether the key's origin travels,
 *  and the program Asset Hub runs. */
function sentXcm(world: World) {
  const message = (submitsOf(world).execute!.args as ExecuteArgs).message;
  const transfer = message.value[2]!.value as {
    remote_fees: { value: { value: Fungible[] } };
    preserve_origin: boolean;
    remote_xcm: Instruction[];
  };
  const [pasWithdrawn, cashWithdrawn] = message.value[0]!.value as Fungible[];
  const payFees = (message.value[1]!.value as { asset: Fungible }).asset.fun.value;
  return {
    cashSold: cashWithdrawn!.fun.value,
    pasTravelling: pasWithdrawn!.fun.value - payFees,
    earmark: transfer.remote_fees.value.value[0]!.fun.value,
    preserveOrigin: transfer.preserve_origin,
    program: transfer.remote_xcm,
  };
}

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
      destinationBefore: DESTINATION_PAS,
      expectedLanding: world.state.lastDryRunLanded,
    });
    expect(run.state.fundsSeenAt).toBe(2_000);
    expect(run.transients).toEqual([]);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + world.state.lastDryRunLanded);
  });

  it("sells for a stable in two hops, each held to its floor, and reads the arrival in that asset", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 3, freshWithdrawTickState(), {
      tier: "pool",
      external: "USDC",
    });
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    const { cashSold, program } = sentXcm(world);
    const hops = program.filter((i) => i.type === "ExchangeAsset");
    expect(hops).toHaveLength(2);
    // The native floor is the sale's quote less the headroom; the stable's is the two hop quote
    // less the same headroom, so the hops share it.
    const nativeQuote = cashSold * AH_RATE;
    expect((hops[0]!.value as Exchange).want[0]!.fun.value).toBe((nativeQuote * 95n) / 100n);
    expect((hops[1]!.value as Exchange).want[0]!.fun.value).toBe(
      ((nativeQuote / STABLE_PLANCK) * 95n) / 100n,
    );
    // What the dry run said lands is in USDC units, read from the USDC deposit, and the
    // destination's USDC holding is what grew by it.
    expect(run.state.expectedLanding).toBe(world.state.lastDryRunLanded);
    expect(run.state.expectedLanding).toBeLessThan(nativeQuote / 1_000n);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + world.state.lastDryRunLanded);
  });

  it("redeems through the PSM as the key's account on Asset Hub, and reads the arrival in the stable", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 3, freshWithdrawTickState(), {
      tier: "psm",
      external: "USDT",
      feeRate: PSM_FEE_RATE,
    });
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    const { cashSold, earmark, preserveOrigin, program } = sentXcm(world);
    expect(preserveOrigin).toBe(true);
    expect(program.map((i) => i.type)).toEqual([
      "SetHints",
      "DepositAsset",
      "Transact",
      "ExpectTransactStatus",
      "WithdrawAsset",
      "RefundSurplus",
      "ExchangeAsset",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    // What travels less the earmark is redeemed, at the fee rate the hand-off froze, as the
    // account Asset Hub named for the key; the call is the one Asset Hub encoded.
    const redeemAmount = cashSold - earmark;
    const held = (program[1]!.value as { assets: { value: Fungible[] } }).assets.value[0]!;
    expect(held.fun.value).toBe(redeemAmount);
    expect((program[2]!.value as { call: Uint8Array }).call).toBe(REDEEM_CALL);
    const out = (program[4]!.value as Fungible[])[0]!.fun.value;
    expect(out).toBe(redeemAmount - permillMulCeil(redeemAmount, PSM_FEE_RATE));
    // The landing is in USDT units: the redeem plus the dust sold on top.
    expect(run.state.expectedLanding).toBe(world.state.lastDryRunLanded);
    expect(run.state.expectedLanding).toBeGreaterThan(out);
    expect(run.state.expectedLanding).toBeLessThan(out + out / 10n);
  });

  it("lands the CASH as dotUSD on the teleport tier, with the PAS that travelled sold for it", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 3, freshWithdrawTickState(), { tier: "teleport" });
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    const { cashSold, pasTravelling, program } = sentXcm(world);
    expect(program.map((i) => i.type)).toEqual([
      "SetHints",
      "RefundSurplus",
      "ExchangeAsset",
      "DepositAsset",
    ]);
    // The landing is the CASH itself less Asset Hub's fee, the earmark's unspent part back in,
    // plus what the PAS sold for; nothing lands as PAS.
    expect(run.state.expectedLanding).toBe(cashSold - AH_FEE_CASH + pasTravelling / AH_RATE);
    expect(world.state.keyCash).toBe(0n);
  });

  it("prices the fees a direct withdrawal takes before the sale from People's pool, for the summary", async () => {
    const world = scriptedWorld();
    const fees = await estimateDirectFeesCash({
      peopleApi: world.peopleApi as never,
      address: KEY.address,
      poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
      assetHubParaId: 1500,
      peopleParaId: 1502,
      sale: { tier: "pool" },
    });
    // The swap for the deposit and the reserve, the swap's own fee, and Asset Hub's buffer, the
    // first two priced in CASH through the pool. Nothing was submitted to learn it.
    expect(fees).toBe(
      cashInFor(ED + RESERVE, RESERVES) +
        cashInFor(SWAP_TX_FEE_PAS, RESERVES) +
        ASSET_HUB_FEE_BUFFER_CASH,
    );
    expect(world.state.submits).toEqual([]);
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
      (cashInFor(ED + RESERVE, RESERVES) * BigInt(100 + SWAP_HEADROOM_PCT)) / 100n,
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
      destinationBefore: DESTINATION_PAS,
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
    state.destinationBefore = null;
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "await-arrival"]);
    expect(world.state.destinationReads).toBe(0);
  });

  it("does not count a deposit from elsewhere as the arrival while the key still holds funds", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    state.submitted = true;
    state.fundsSeenAt = 1_000;
    state.destinationBefore = DESTINATION_PAS;
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
