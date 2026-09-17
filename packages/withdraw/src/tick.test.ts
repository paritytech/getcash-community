// Offline coverage over a scripted People and Asset Hub: the two transactions in order, the fee
// measurement converging on an exact allowance, the CASH leaving to the unit, arrival by message
// id, and every refusal.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { SWAP_HEADROOM_PCT, XCM_TX_FEE_HEADROOM_PCT } from "./fees";
import { PASEO_PEOPLE_POOL_ACCOUNT } from "./paseo";
import { cashInFor } from "./pool";
import {
  freshWithdrawTickState,
  MAX_REJECTIONS,
  messageIdOf,
  withdrawTickOnce,
  WithdrawRejectedError,
  WithdrawTrappedError,
  type WithdrawStep,
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
const MESSAGE_ID = `0x${"5e".repeat(32)}`;

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
    /** Asset Hub's message queue reports the message after this many searches. */
    arrivalAfterSearches?: number;
    /** Asset Hub fails the program when it processes the message. */
    trapOnArrival?: boolean;
    /** People rejects the XCM at inclusion with this XCM error. */
    rejectXcm?: string;
    /** The XCM submit's events carry no Sent event. */
    loseMessageId?: boolean;
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
    searches: 0,
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
      if (opts.loseXcmAnswer) throw new Error("withdrawal submit timed out after 1s");
      return {
        ok: true,
        txHash: txHashFor(),
        block: { number: 500 },
        events: opts.loseMessageId
          ? []
          : [{ type: "PolkadotXcm", value: { type: "Sent", value: { message_id: MESSAGE_ID } } }],
      };
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
    apis: {
      AssetConversionApi: {
        quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, cashIn: bigint) =>
          cashIn * AH_RATE,
      },
      DryRunApi: {
        // Asset Hub sells every CASH it receives and deposits all the PAS to the destination.
        dry_run_xcm: async (_origin: unknown, forwarded: Message) => {
          const travelling = forwarded.value[2]!.value as Fungible[];
          const earmark = (forwarded.value[0]!.value as Fungible[])[0]!.fun.value;
          const pas = travelling.length === 2 ? travelling[0]!.fun.value : 0n;
          const cash = travelling[travelling.length - 1]!.fun.value + earmark - 3_546n;
          const events: unknown[] = [
            {
              type: "Balances",
              value: {
                type: "Deposit",
                value: { who: DESTINATION_SS58, amount: pas + cash * AH_RATE },
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

  const findMessageOutcome = async (_id: string, fromBlock: number) => {
    state.searches += 1;
    if (state.searches < (opts.arrivalAfterSearches ?? 1))
      return { outcome: null, scannedTo: fromBlock + 5 };
    return {
      outcome: { success: !opts.trapOnArrival, block: fromBlock + 2 },
      scannedTo: fromBlock + 2,
    };
  };

  return { state, peopleApi, assetHubApi, findMessageOutcome };
}

type World = ReturnType<typeof scriptedWorld>;

async function drive(
  world: World,
  ticks: number,
  state: WithdrawTickState = freshWithdrawTickState(),
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
        assetHubBestBlock: async () => 1_000,
        findMessageOutcome: world.findMessageOutcome,
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

describe("withdrawTickOnce", () => {
  it("waits for CASH, swaps, then sizes, proves and submits the XCM, then follows the message to done", async () => {
    const world = scriptedWorld({ arrivalAfterSearches: 2 });
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
      messageId: MESSAGE_ID,
    });
    expect(run.state.fundsSeenAt).toBe(2_000);
    expect(run.transients).toEqual([]);
    // The search resumed from where it stopped, never from the start.
    expect(run.state.scannedToBlock).toBeGreaterThan(1_000);
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

  it("ends the run when Asset Hub fails the message, and keeps it alive while unprocessed", async () => {
    const world = scriptedWorld({ arrivalAfterSearches: 3, trapOnArrival: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state);
    const waiting = await drive(world, 1, state);
    expect(waiting.steps).toEqual(["await-arrival"]);
    await expect(drive(world, 2, state)).rejects.toBeInstanceOf(WithdrawTrappedError);
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

  it("holds in await-arrival when the submit's answer carried no message id", async () => {
    const world = scriptedWorld({ loseMessageId: true });
    const state = freshWithdrawTickState();
    const first = await drive(world, 2, state);
    expect(first.steps).toEqual(["swap", "convert"]);
    expect(first.transients[0]).toMatch(/no message id/);
    expect(state.messageId).toBeNull();
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "await-arrival"]);
    expect(world.state.searches).toBe(0);
  });

  it("holds in await-arrival when the XCM emptied the key but its answer was lost", async () => {
    const world = scriptedWorld({ loseXcmAnswer: true });
    const state = freshWithdrawTickState();
    await drive(world, 1, state);
    await expect(drive(world, 1, state)).rejects.toThrow(/timed out/);
    expect(state).toMatchObject({ attempts: 2, submitted: false });
    expect(world.state.keyCash).toBe(0n);
    // An empty key after a submit is not an unpaid key.
    const later = await drive(world, 2, state);
    expect(later.steps).toEqual(["await-arrival", "await-arrival"]);
    expect(state).toMatchObject({ submitted: true, messageId: null });
    expect(world.state.searches).toBe(0);
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

describe("messageIdOf", () => {
  it("reads the Sent event's id, and nothing from other events", () => {
    expect(
      messageIdOf([
        { type: "System", value: { type: "ExtrinsicSuccess", value: {} } },
        { type: "PolkadotXcm", value: { type: "Sent", value: { message_id: "0xab" } } },
      ]),
    ).toBe("0xab");
    expect(
      messageIdOf([{ type: "System", value: { type: "ExtrinsicSuccess", value: {} } }]),
    ).toBeNull();
  });
});
