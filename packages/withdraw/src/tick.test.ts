// Offline coverage over a scripted People and Asset Hub: the two transactions in order, the fee
// measurement converging on an exact allowance, the CASH leaving to the unit, arrival by the
// destination's balance, and every refusal.
//
// And, for an off-ramp, the third transaction: the solvency floor the commitment puts under the
// sale, the exact payment on Asset Hub, its retries, and the property that matters more than any
// other here — that no reload, no lost answer and no failed inclusion can make it pay twice.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import {
  ASSET_HUB_TRANSFER_FEE_HEADROOM_PCT,
  CommitmentUnfundableError,
  SWAP_HEADROOM_PCT,
  XCM_TX_FEE_HEADROOM_PCT,
} from "./fees";
import { PASEO_PEOPLE_POOL_ACCOUNT } from "./paseo";
import { cashInFor } from "./pool";
import {
  freshWithdrawTickState,
  landingFloor,
  MAX_REJECTIONS,
  MAX_PAY_ATTEMPTS,
  paymentResolved,
  PaymentUnresolvedError,
  restoreWithdrawTickState,
  serialiseWithdrawTickState,
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
const DESTINATION_HEX = `0x${"aa".repeat(32)}`;
/** What the destination holds before any withdrawal reaches it. */
const DESTINATION_PAS = 3n * ED;
/** Asset Hub's existential deposit and what it charges the provider payment. The sizing and the
 *  gate both work from the padded figure, so a fee that drifts between them cannot stall. */
const AH_ED = 1_000_000_000n;
const AH_TRANSFER_FEE = 15_000_000n;
const AH_FEE_PADDED = (AH_TRANSFER_FEE * BigInt(100 + ASSET_HUB_TRANSFER_FEE_HEADROOM_PCT)) / 100n;
/** The provider's deposit address, and the exact figure it was committed. */
const PAYOUT = AccountId(42).dec(new Uint8Array(32).fill(0xbb));
const COMMIT = 70_000_000_000n;

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
    /** Asset Hub rejects the provider payment at inclusion until this is cleared. */
    rejectPayment?: boolean;
    /** The payment lands but the submit's answer never comes back. */
    losePaymentAnswer?: boolean;
    /** The payment's broadcast never reaches the chain: nothing included, nothing charged. */
    dropPaymentSubmit?: boolean;
    /** Asset Hub refuses the payment's dry run. */
    rejectPaymentDryRun?: boolean;
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
    /** The burner's own Asset Hub account, where an off-ramp's sale lands. */
    burnerAhFree: 0n,
    burnerAhNonce: 0,
    /** What actually reached the provider's address. */
    paidOut: 0n,
    rejectPayment: opts.rejectPayment ?? false,
    losePaymentAnswer: opts.losePaymentAnswer ?? false,
    dropPaymentSubmit: opts.dropPaymentSubmit ?? false,
    /** A burner read that lags the chain, as a read at an older head does. */
    burnerReadLag: null as { free: bigint; nonce: number } | null,
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

  /** The payment as Asset Hub runs it: the fee comes off first and always, the transfer moves
   *  the value only when it succeeds, and either way the nonce is spent. */
  const transferTx = (args: { dest: unknown; value: bigint }) => ({
    decodedCall: { type: "Balances", value: { type: "transfer_keep_alive", value: args } },
    getEstimatedFees: async () => AH_TRANSFER_FEE,
    signAndSubmit: async (signer: unknown, options: Record<string, unknown>) => {
      state.submits.push({ call: "pay", args: { ...args, signer }, options });
      // The chain refuses a transaction at a nonce it has already consumed. This is the whole
      // mechanism: a retry of a payment that was included is stale, not a second payment.
      const nonce = options.nonce;
      if (typeof nonce === "number" && nonce < state.burnerAhNonce) {
        throw new Error(`Invalid Transaction: Stale (nonce ${nonce})`);
      }
      // A broadcast that never reached the chain: no nonce spent, no fee, nothing included.
      if (state.dropPaymentSubmit) {
        throw new Error("provider payment submit timed out after 1s");
      }
      state.burnerAhNonce += 1;
      state.burnerAhFree -= AH_TRANSFER_FEE;
      if (state.rejectPayment) {
        return {
          ok: false,
          txHash: txHashFor(),
          dispatchError: moduleError("Balances", "InsufficientBalance"),
          events: [],
        };
      }
      state.burnerAhFree -= args.value;
      state.paidOut += args.value;
      if (state.losePaymentAnswer) throw new Error("provider payment submit timed out after 1s");
      return { ok: true, txHash: txHashFor(), block: { number: 501 }, events: [] };
    },
  });

  const assetHubApi = {
    constants: { Balances: { ExistentialDeposit: async () => AH_ED } },
    tx: { Balances: { transfer_keep_alive: transferTx } },
    apis: {
      AssetConversionApi: {
        quote_price_exact_tokens_for_tokens: async (_a: unknown, _b: unknown, cashIn: bigint) =>
          cashIn * AH_RATE,
      },
      DryRunApi: {
        // The payment as a dry run: it completes as long as the account can afford it.
        dry_run_call: async () =>
          opts.rejectPaymentDryRun
            ? rejectedExecution(moduleError("Balances", "InsufficientBalance"))
            : {
                success: true,
                value: {
                  execution_result: { success: true, value: {} },
                  emitted_events: [],
                  forwarded_xcms: [],
                },
              },
        // Asset Hub sells every CASH it receives and deposits all the PAS to the destination.
        dry_run_xcm: async (_origin: unknown, forwarded: Message) => {
          const travelling = forwarded.value[2]!.value as Fungible[];
          const earmark = (forwarded.value[0]!.value as Fungible[])[0]!.fun.value;
          const pas = travelling.length === 2 ? travelling[0]!.fun.value : 0n;
          const cash = travelling[travelling.length - 1]!.fun.value + earmark - 3_546n;
          state.lastDryRunLanded = pas + cash * AH_RATE;
          // The deposit goes wherever the program says: the destination for a self-custody
          // withdrawal, the burner's own account for an off-ramp.
          const beneficiaryHex = (
            forwarded.value[7]!.value as {
              beneficiary: { interior: { value: { value: { id: string } } } };
            }
          ).beneficiary.interior.value.value.id;
          const events: unknown[] = [
            {
              type: "Balances",
              value: {
                type: "Deposit",
                value: { who: AccountId(42).dec(beneficiaryHex), amount: pas + cash * AH_RATE },
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

  /** The burner's own Asset Hub account: an off-ramp's sale lands here instead. */
  const readBurnerOnAssetHub = async () => {
    if (state.xcmLanded && !state.pasLanded) {
      state.destinationReads += 1;
      if (state.destinationReads >= (opts.arrivalAfterReads ?? 1)) {
        state.burnerAhFree += state.lastDryRunLanded - (opts.landShort ?? 0n);
        state.pasLanded = true;
      }
    }
    return state.burnerReadLag ?? { free: state.burnerAhFree, nonce: state.burnerAhNonce };
  };

  return { state, peopleApi, assetHubApi, readDestinationOnAssetHub, readBurnerOnAssetHub };
}

type World = ReturnType<typeof scriptedWorld>;

async function drive(
  world: World,
  ticks: number,
  state: WithdrawTickState = freshWithdrawTickState(),
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
  pay: world.state.submits.find((s) => s.call === "pay"),
});

/** The key's Asset Hub signer, which a self-custody withdrawal never supplies. */
const AH_SIGNER = {} as never;
/** The Asset Hub submit anchors on a best block, as the worker's signOptionsFor does. */
const AH_SIGN_OPTIONS = { at: `0x${"ab".repeat(32)}` };

/** What a driver adds to the tick to make it an off-ramp. */
const offRamp = (world: World, planck = COMMIT): Partial<WithdrawTickInput> => ({
  key: { ...KEY, assetHubSigner: AH_SIGNER },
  commitment: { planck, payoutAddress: PAYOUT },
  readBurnerOnAssetHub: world.readBurnerOnAssetHub,
  assetHubSignOptions: AH_SIGN_OPTIONS,
});

/** A reload, through the real persistence pair and real JSON — the only kind worth asserting on.
 *  A shallow copy would keep fields a driver never stored and prove nothing. */
const reloaded = (state: WithdrawTickState): WithdrawTickState =>
  restoreWithdrawTickState(JSON.parse(JSON.stringify(serialiseWithdrawTickState(state))));

/** The CASH the XCM sells, and what Asset Hub quotes for it, at the scripted reserves. */
const CASH_SOLD = KEY_CASH - SWAP_FEE_CASH - cashInFor(ED + RESERVE, RESERVES);
const QUOTED = CASH_SOLD * AH_RATE;
/** The least the sale may return, read out of the submitted XCM's remote program. */
const floorOf = (world: World) => {
  const message = (submitsOf(world).execute!.args as ExecuteArgs).message;
  const transfer = message.value[2]!.value as { remote_xcm: Instruction[] };
  const exchange = transfer.remote_xcm[2]!.value as { want: Fungible[] };
  return exchange.want[0]!.fun.value;
};

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

describe("withdrawTickOnce with a commitment", () => {
  it("sells to the burner, then pays the provider exactly the committed figure on Asset Hub", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 5, undefined, offRamp(world));
    expect(run.steps).toEqual(["swap", "convert", "pay-provider", "done"]);

    const { execute, pay } = submitsOf(world);
    // The sale went to the burner's own account, not to the provider and not to the destination.
    const message = (execute!.args as ExecuteArgs).message;
    const transfer = message.value[2]!.value as { remote_xcm: Instruction[] };
    const beneficiary = (
      transfer.remote_xcm[3]!.value as {
        beneficiary: { interior: { value: { value: { id: string } } } };
      }
    ).beneficiary.interior.value.value.id;
    expect(beneficiary).toBe(KEY.publicKeyHex);
    expect(beneficiary).not.toBe(DESTINATION_HEX);

    // And the payment is exact: a plain transfer of the figure, to the provider's address.
    const args = pay!.args as { dest: { type: string; value: string }; value: bigint };
    expect(args.value).toBe(COMMIT);
    expect(args.dest).toEqual({ type: "Id", value: PAYOUT });
    expect(world.state.paidOut).toBe(COMMIT);
    expect(run.state).toMatchObject({ payAttempts: 1, payRejections: 0, payAmount: COMMIT });
  });

  it("signs the payment on Asset Hub with the Asset Hub signer, and without People's extension", async () => {
    const world = scriptedWorld();
    await drive(world, 5, undefined, offRamp(world));
    const { pay } = submitsOf(world);
    expect((pay!.args as { signer: unknown }).signer).toBe(AH_SIGNER);
    expect(pay!.options).toMatchObject({ ...AH_SIGN_OPTIONS, nonce: 0 });
    // The fee is paid in the PAS the sale landed, so neither of People's options belongs here.
    expect(pay!.options).not.toHaveProperty("asset");
    expect(pay!.options).not.toHaveProperty("customSignedExtensions");
  });

  it("does not reap the burner: the payment keeps the account alive for the residue", async () => {
    const world = scriptedWorld();
    await drive(world, 5, undefined, offRamp(world));
    // Asset Hub scripts only `transfer_keep_alive`, so a payment that reached it at all took the
    // variant that leaves the account standing — and the residue a later step returns is still
    // there, above the deposit.
    expect(submitsOf(world).pay).toBeDefined();
    expect(world.state.burnerAhFree).toBeGreaterThan(AH_ED);
  });

  it("floors the sale at the payment, its fee and the deposit when that is above the slippage floor", async () => {
    const slippageFloor = (QUOTED * 95n) / 100n;
    const high = 76_000_000_000n;
    expect(high + AH_FEE_PADDED + AH_ED).toBeGreaterThan(slippageFloor);

    const world = scriptedWorld();
    await drive(world, 2, undefined, offRamp(world, high));
    expect(floorOf(world)).toBe(high + AH_FEE_PADDED + AH_ED);

    // A commitment the slippage floor already covers leaves the floor where it was.
    const modest = scriptedWorld();
    await drive(modest, 2, undefined, offRamp(modest));
    expect(COMMIT + AH_FEE_PADDED + AH_ED).toBeLessThan(slippageFloor);
    expect(floorOf(modest)).toBe(slippageFloor);
  });

  it("gives up distinctly, before anything is signed, when the pool cannot fund the commitment", async () => {
    const world = scriptedWorld();
    const unfundable = QUOTED + 1n;
    const state = freshWithdrawTickState();
    await drive(world, 1, state, offRamp(world, unfundable));
    // The swap went out; the XCM never did, because the sale could not reach the floor.
    await expect(drive(world, 1, state, offRamp(world, unfundable))).rejects.toBeInstanceOf(
      CommitmentUnfundableError,
    );
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap"]);
    expect(state.submitted).toBe(false);
    expect(world.state.paidOut).toBe(0n);
  });

  it("retries the payment on its own counter, and leaves the XCM's alone", async () => {
    const world = scriptedWorld({ rejectPayment: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/pay-provider rejected/);
    expect(state).toMatchObject({ payRejections: 1, payAttempts: 1, rejections: 0 });
    // An answered rejection consumed the pin and paid nothing, so the pin moves ON to the
    // nonce the next attempt will use. Clearing it instead would leave the next tick with no
    // pin facing a burner whose nonce has moved — the reading that means "a payment was lost".
    expect(state.payNonce).toBe(1);
    expect(state.payAmount).toBeNull();
    expect(paymentResolved(state)).toBe(true);
    expect(world.state.paidOut).toBe(0n);

    // The next tick tries again and this time Asset Hub takes it.
    world.state.rejectPayment = false;
    const later = await drive(world, 2, state, offRamp(world));
    expect(later.steps).toEqual(["pay-provider", "done"]);
    expect(world.state.paidOut).toBe(COMMIT);
    expect(state.payAttempts).toBe(2);
  });

  it("gives up for good after the payment is rejected at inclusion the cap's worth of times", async () => {
    const world = scriptedWorld({ rejectPayment: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    for (let rejection = 1; rejection < MAX_REJECTIONS; rejection += 1) {
      await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/pay-provider rejected/);
    }
    await expect(drive(world, 1, state, offRamp(world))).rejects.toBeInstanceOf(
      WithdrawRejectedError,
    );
    expect(state.payRejections).toBe(MAX_REJECTIONS);
    expect(world.state.paidOut).toBe(0n);
  });

  it("never pays twice: a reload after the payment reads the chain and finishes", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    const run = await drive(world, 3, state, offRamp(world));
    expect(run.steps).toEqual(["swap", "convert", "pay-provider"]);
    expect(world.state.paidOut).toBe(COMMIT);

    // The process restarts with only what a driver actually stored, through the real
    // serialise/restore pair: the confirmed hash, the pin, and the balance it was taken at.
    const after = reloaded(state);
    expect(after.paidTxHash).toBe(state.paidTxHash);
    expect(after.payFreeBefore).toBe(state.payFreeBefore);
    const resumed = await drive(world, 3, after, offRamp(world));
    expect(resumed.steps).toEqual(["done"]);
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(1);
    expect(world.state.paidOut).toBe(COMMIT);
  });

  it("never pays twice when the submit's answer was lost: the nonce and the balance both moved", async () => {
    const world = scriptedWorld({ losePaymentAnswer: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/timed out/);
    // The evidence was written before the broadcast, so the reload has something to check.
    expect(state.payNonce).toBe(0);
    expect(state.payFreeBefore).not.toBeNull();

    const after = reloaded(state);
    const resumed = await drive(world, 2, after, offRamp(world));
    expect(resumed.steps).toEqual(["done"]);
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(1);
    expect(world.state.paidOut).toBe(COMMIT);
    // The "done" above came from the balance-inference branch, not an answered submit: no hash
    // to show for it, so paidTxHash stays null. Without paidByInference, paymentResolved would
    // read false forever from here on -- a withdrawal stuck `done` with no evidence anyone will
    // ever accept as resolved, and a residue return permanently refused for a payment that, as
    // far as this code can tell, plainly went through.
    expect(resumed.state.paidTxHash).toBeNull();
    expect(resumed.state.paidByInference).toBe(true);
    expect(paymentResolved(resumed.state)).toBe(true);
  });

  it("refuses to decide when the pin was used and the money is still there", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    // Stand where a tick stands after a submit whose answer was lost: the pinned nonce has been
    // consumed, but the balance has not fallen. That is an included failure OR a payment whose
    // proceeds something has since replaced, and the head cannot tell them apart. The old code
    // called this "proven unpaid" and paid again; it is not proven anything.
    const burner = await world.readBurnerOnAssetHub();
    state.payNonce = burner.nonce;
    state.payFreeBefore = burner.free;
    state.payAmount = COMMIT;
    world.state.burnerAhNonce += 1;

    await expect(drive(world, 1, reloaded(state), offRamp(world))).rejects.toBeInstanceOf(
      PaymentUnresolvedError,
    );
    expect(world.state.paidOut).toBe(0n);
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(0);
  });

  it("pins the nonce on the first attempt and reuses it on every retry", async () => {
    // Broadcasts that never reach the chain: nothing is included, so retrying is right and the
    // pin must not move between attempts.
    const world = scriptedWorld({ dropPaymentSubmit: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/timed out/);
    const pinned = state.payNonce;
    expect(pinned).toBe(0);

    // The pin survives a real reload, and it is what the retry submits at.
    const after = reloaded(state);
    expect(after.payNonce).toBe(pinned);
    await expect(drive(world, 1, after, offRamp(world))).rejects.toThrow(/timed out/);
    world.state.dropPaymentSubmit = false;
    await drive(world, 1, after, offRamp(world));
    const nonces = world.state.submits.filter((s) => s.call === "pay").map((s) => s.options.nonce);
    expect(nonces).toEqual([pinned, pinned, pinned]);
    expect(world.state.paidOut).toBe(COMMIT);
  });

  it("lets the chain refuse a retry of a payment that was already included", async () => {
    // The property the whole design rests on, exercised directly: a second submit at a pin the
    // chain has consumed is stale, not a second payment. No belief about balances involved.
    const world = scriptedWorld();
    await drive(world, 3, undefined, offRamp(world));
    expect(world.state.paidOut).toBe(COMMIT);
    const payment = world.assetHubApi.tx.Balances.transfer_keep_alive({
      dest: { type: "Id", value: PAYOUT },
      value: COMMIT,
    });
    await expect(payment.signAndSubmit(AH_SIGNER, { nonce: 0 })).rejects.toThrow(/Stale/);
    expect(world.state.paidOut).toBe(COMMIT);
  });

  it("stops rather than retry forever when the payment will not resolve", async () => {
    const world = scriptedWorld({ dropPaymentSubmit: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    for (let attempt = 1; attempt <= MAX_PAY_ATTEMPTS; attempt += 1) {
      await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/timed out/);
    }
    await expect(drive(world, 1, state, offRamp(world))).rejects.toBeInstanceOf(
      PaymentUnresolvedError,
    );
    expect(state.payAttempts).toBe(MAX_PAY_ATTEMPTS);
    expect(world.state.paidOut).toBe(0n);
  });

  it("refuses a commitment it has no way to pay out, before it moves any money", async () => {
    const world = scriptedWorld();
    // A caller that forgot the Asset Hub signer. Discovered now, not after the sale is sitting
    // on the burner with nothing able to move it.
    await expect(
      drive(world, 1, undefined, {
        commitment: { planck: COMMIT, payoutAddress: PAYOUT },
        readBurnerOnAssetHub: world.readBurnerOnAssetHub,
      }),
    ).rejects.toThrow(/needs an Asset Hub signer/);
    expect(world.state.submits).toEqual([]);
    expect(world.state.keyCash).toBe(KEY_CASH);
  });

  it("tells the residue step when the payment is still in flight", async () => {
    const world = scriptedWorld({ dropPaymentSubmit: true });
    const state = freshWithdrawTickState();
    expect(paymentResolved(state)).toBe(true);
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/timed out/);
    // A pin is out and unconfirmed: the residue return must not sign from the burner, or it
    // consumes the pin and the payment can never be resolved either way.
    expect(paymentResolved(state)).toBe(false);
    world.state.dropPaymentSubmit = false;
    await drive(world, 1, state, offRamp(world));
    expect(paymentResolved(state)).toBe(true);
  });

  it("holds in await-arrival until the sale has landed enough to cover the payment", async () => {
    const world = scriptedWorld({ arrivalAfterReads: 3 });
    const run = await drive(world, 4, undefined, offRamp(world));
    expect(run.steps).toEqual(["swap", "convert", "await-arrival", "await-arrival"]);
    expect(world.state.paidOut).toBe(0n);
  });

  it("refuses to pay when Asset Hub's dry run refuses the transfer", async () => {
    const world = scriptedWorld({ rejectPaymentDryRun: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(
      /Asset Hub rejects the payment/,
    );
    expect(world.state.paidOut).toBe(0n);
    expect(state.payNonce).toBeNull();
  });

  it("stops rather than pay a figure that changed while one was already out", async () => {
    const world = scriptedWorld({ losePaymentAnswer: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/timed out/);
    await expect(drive(world, 1, state, offRamp(world, COMMIT + 1n))).rejects.toThrow(
      /the commitment changed/,
    );
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(1);
  });

  it("does not broadcast a payment whose pin it could not persist", async () => {
    // The hole the pin alone does not close: a best-effort write that silently fails, a
    // broadcast that goes anyway, and a reload with no memory of it. The driver's persist must
    // throw, and a throw there must stop the submit before anything reaches the chain.
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    const beforeThePin = reloaded(state);
    await expect(
      drive(world, 1, state, {
        ...offRamp(world),
        onBeforeSubmit: () => {
          throw new Error("product storage unavailable");
        },
      }),
    ).rejects.toThrow(/storage unavailable/);
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(0);
    expect(world.state.paidOut).toBe(0n);
    expect(world.state.burnerAhNonce).toBe(0);

    // And the reload, from the record as it stood before the pin that was never written, pays
    // once and only once.
    const resumed = await drive(world, 3, beforeThePin, offRamp(world));
    expect(resumed.steps).toEqual(["pay-provider", "done"]);
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(1);
    expect(world.state.paidOut).toBe(COMMIT);
  });

  it("refuses to pin afresh when the burner has already signed on Asset Hub", async () => {
    // The backstop for a pin that was lost anyway — a write that vanished, or a second driver
    // in another tab whose memory never held it. The payment is the only thing this burner ever
    // signs, so a nonce above zero with no pin means a payment is already out there. Taking a
    // fresh pin is the one move that pays twice, and the balance reading is not what stops it.
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 3, state, offRamp(world));
    expect(world.state.paidOut).toBe(COMMIT);
    // A driver that lost the pin: the record it holds knows only that the XCM went out.
    const amnesiac = reloaded({ ...state, payNonce: null, payAmount: null, paidTxHash: null });
    // Give it enough on the burner that the balance gate would happily let a second payment
    // through — which is exactly the case the old inference could not survive.
    world.state.burnerAhFree += 2n * COMMIT;
    await expect(drive(world, 1, amnesiac, offRamp(world))).rejects.toBeInstanceOf(
      PaymentUnresolvedError,
    );
    expect(world.state.paidOut).toBe(COMMIT);
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(1);
  });

  it("pins the behaviour of a second writer working from a diverged copy", async () => {
    // Single writer is a precondition, not a wish. Two drivers from one record: the first pays,
    // the second still believes nothing is pinned. It must not pay, and it must say so.
    const world = scriptedWorld();
    const shared = freshWithdrawTickState();
    await drive(world, 2, shared, offRamp(world));
    const writerA = reloaded(shared);
    const writerB = reloaded(shared);
    await drive(world, 1, writerA, offRamp(world));
    expect(world.state.paidOut).toBe(COMMIT);
    await expect(drive(world, 1, writerB, offRamp(world))).rejects.toBeInstanceOf(
      PaymentUnresolvedError,
    );
    expect(world.state.submits.filter((s) => s.call === "pay")).toHaveLength(1);
  });

  it("does not strand a payment whose rejection was answered but never persisted", async () => {
    // The crash window between the pin moving on and the next save. The state that reaches the
    // chain's next reader must already say the pin was spent, or the tick after reads "pin used,
    // money still here" and refuses forever a payment that plainly failed.
    const world = scriptedWorld({ rejectPayment: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    const checkpoints: WithdrawTickState[] = [];
    await expect(
      drive(world, 1, state, {
        ...offRamp(world),
        onStateCheckpoint: () => {
          checkpoints.push(reloaded(state));
        },
      }),
    ).rejects.toThrow(/pay-provider rejected/);
    // The release was checkpointed at the moment it happened, not left to the tick's end.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.payNonce).toBe(1);
    // A process that died right after that checkpoint resumes and retries, rather than jamming.
    world.state.rejectPayment = false;
    const resumed = await drive(world, 3, checkpoints[0]!, offRamp(world));
    expect(resumed.steps).toEqual(["pay-provider", "done"]);
    expect(world.state.paidOut).toBe(COMMIT);
  });

  it("does not count a stale-nonce refusal against the attempt bound", async () => {
    // A retry the chain refuses because the pin is spent is evidence the payment went in. The
    // old accounting burned an attempt for it and could fail a perfectly good payment at the
    // bound, one tick before the reading that would have resolved it.
    const world = scriptedWorld({ losePaymentAnswer: true });
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/timed out/);
    expect(state.payAttempts).toBe(1);
    // A tick whose account read lags the chain: the pin still looks unused and the money still
    // looks there, so it retries — straight into a nonce the chain has already spent.
    world.state.burnerReadLag = { free: state.payFreeBefore!, nonce: state.payNonce! };
    world.state.losePaymentAnswer = false;
    await expect(drive(world, 1, state, offRamp(world))).rejects.toThrow(/already spent/);
    expect(state.payAttempts).toBe(1);
    expect(world.state.paidOut).toBe(COMMIT);
    // And once the read catches up, the same evidence resolves it as paid.
    world.state.burnerReadLag = null;
    const resolved = await drive(world, 1, state, offRamp(world));
    expect(resolved.steps).toEqual(["done"]);
  });

  it("reads a pin spent by something else that moved the money as paid, which is why nothing else may sign", async () => {
    // The false-positive direction, pinned honestly. If another transaction consumed the pin
    // and took at least the committed amount out, this reads as paid and the provider never
    // was. Nothing in the chain's head distinguishes the two, which is precisely why contract 3
    // forbids anything else signing from the burner before the payment resolves.
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 2, state, offRamp(world));
    const burner = await world.readBurnerOnAssetHub();
    state.payNonce = burner.nonce;
    state.payFreeBefore = burner.free;
    state.payAmount = COMMIT;
    // Somebody else's transaction, from the burner, spending the pin and the money.
    world.state.burnerAhNonce += 1;
    world.state.burnerAhFree -= COMMIT;
    const run = await drive(world, 1, reloaded(state), offRamp(world));
    expect(run.steps).toEqual(["done"]);
    expect(world.state.paidOut).toBe(0n);
  });

  it("round-trips every field of the state through the driver's persistence, bigints included", async () => {
    const world = scriptedWorld();
    const state = freshWithdrawTickState();
    await drive(world, 3, state, offRamp(world));
    const stored = JSON.parse(JSON.stringify(serialiseWithdrawTickState(state)));
    // Every key is written, and nothing was quietly left behind: this is the failure that hid
    // the pinned nonce from the worker's persister, and it is generic so it cannot come back.
    expect(Object.keys(stored).sort()).toEqual(Object.keys(state).sort());
    expect(restoreWithdrawTickState(stored)).toEqual(state);
    expect(typeof state.payFreeBefore).toBe("bigint");
    // A record written by an older build restores into the current shape rather than failing.
    expect(restoreWithdrawTickState({ attempts: 2, gone: true })).toEqual({
      ...freshWithdrawTickState(),
      attempts: 2,
    });
    // Including one from before the boxing, which stored these two as bare decimal strings.
    // Reading that form is what let the record version stay where it was: a bump would leave a
    // live withdrawal unticked and unfailed, with funds on a burner nobody is driving.
    expect(
      restoreWithdrawTickState({
        attempts: 1,
        rejections: 0,
        submitted: true,
        destinationPasBefore: "3000000000",
        expectedLanding: "79000000000",
        fundsSeenAt: 2_000,
      }),
    ).toEqual({
      ...freshWithdrawTickState(),
      attempts: 1,
      submitted: true,
      destinationPasBefore: 3_000_000_000n,
      expectedLanding: 79_000_000_000n,
      fundsSeenAt: 2_000,
    });
  });

  it("leaves the self-custody path exactly as it was when no commitment is given", async () => {
    const world = scriptedWorld();
    const run = await drive(world, 4);
    expect(run.steps).toEqual(["swap", "convert", "done"]);
    // Nothing was signed on Asset Hub, nothing was paid, and the destination got the PAS.
    expect(world.state.submits.map((s) => s.call)).toEqual(["swap", "execute"]);
    expect(world.state.paidOut).toBe(0n);
    expect(world.state.burnerAhFree).toBe(0n);
    expect(world.state.destinationPas).toBe(DESTINATION_PAS + world.state.lastDryRunLanded);
    expect(run.state).toMatchObject({
      payAttempts: 0,
      payRejections: 0,
      payNonce: null,
      payFreeBefore: null,
      payAmount: null,
    });
  });
});
