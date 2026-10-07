// The withdrawal pipeline: moves the CASH a disposable key holds on People to a destination on
// Asset Hub, as the asset the hand-off's sale lands, in two transactions signed by the key. The
// host pays the key; this waits for that CASH, buys the PAS the fees need, sizes and proves the
// XCM, submits it once, and waits for the funds to show on the destination. The PSM tier signs a
// third: its XCM lands the CASH on the key's own Asset Hub account, and the key redeems it there
// for the stable, or sells it on the pool once the user chose that from a hold (redeem.ts).
//
// EVERYTHING THE KEY HOLDS LEAVES. The XCM is sized from the key's whole CASH balance after the
// swap, read to the unit, and the PAS left for the transaction fee's headroom is reaped with the
// account. The redeem takes everything but its fee's margin and the CASH account's minimum.
//
// ARRIVAL IS A BALANCE READ AT THE HEAD, like every other read here. The destination account is
// not ours, so its balance in the landing asset is measured against a baseline taken just before
// the XCM leaves, and the arrival is what the Asset Hub dry run said would land, less the
// slippage the program itself allows: a sale that slips further fails the program, so nothing
// less can be a landing. The key must hold no CASH too, which says the XCM executed on People; a
// deposit from elsewhere alone does not count. The redeem's landing is read the same way, exact,
// since the PSM's rate is fixed. Nothing is followed through block history: hosts serve the
// current head and nothing older, and a run that resumes after a reload has no memory but the
// persisted state. A program that fails on Asset Hub traps its assets there and never shows on
// the destination; the run holds until the driver's bound, and the claimer named in the program
// can recover the assets.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the key's CASH and PAS and acts at most once.
// PAS on the key means the swap happened; the XCM is next; CASH on the key's Asset Hub account
// means the XCM landed and the redeem is next. A reload resumes from the persisted state. A tick
// that throws is retried on the next tick. Terminal is a transaction rejected at inclusion after
// the dry run passed, three times over, since each rejection costs a fee and the same transaction
// will not pass on the fourth try; and, on the PSM tier, the PSM refusing the redeem three times
// for a reason waiting cannot clear, or once for one no retry can. A PSM short of room is not
// terminal: the run waits on Asset Hub, spending nothing, until a mint makes room.

import type { PolkadotSigner } from "polkadot-api";
import {
  describeDispatchError,
  MAX_PSM_REFUSALS,
  ProgramRejectedError,
  psmRefusalKind,
  readRedeemCapacity,
  type CashTransfer,
  type ConversionRoute,
  type PsmRefusalKind,
  type PsmRoute,
} from "@getsome/funding";
import { bounded } from "./bounded";
import { ASSET_HUB_CASH_TX_OPTIONS, PEOPLE_TX_OPTIONS } from "./paseo";
import {
  CommitmentUnfundableError,
  lessHeadroom,
  NeedsSwapError,
  sizeSwap,
  sizeXcm,
  type AssetHubApi,
} from "./fees";
import { buildSwap, buildWithdrawXcm, withdrawMessage, type PeopleApi } from "./program";
import {
  addressOf,
  buildPoolExit,
  buildRedeemBatch,
  cashToExit,
  dryRunRedeem,
  estimateRedeemFeeCash,
  quotePoolExit,
  readRedeemFloors,
  sizeRedeem,
  type ExitCall,
} from "./redeem";

/** 'swap' buys the PAS the fees need; 'convert' submits the XCM; 'await-arrival' holds while the
 *  funds have not shown on the destination, or, on the PSM tier, on the key's Asset Hub account;
 *  'redeem' is the PSM tier's exit from there. */
export type WithdrawStep = "await-cash" | "swap" | "convert" | "await-arrival" | "redeem" | "done";

/** The transactions the tick signs, by name. */
type TickCall = "swap" | "withdraw" | "redeem" | "pool-exit";

/** Bound on a tick's chain reads and dry runs. */
export const DEFAULT_WITHDRAW_TICK_TIMEOUT_MS = 30_000;
/** Bound on a submitted transaction's resolution. */
export const DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS = 180_000;
/** Headroom below the quoted sale on Asset Hub before the program fails there. */
export const DEFAULT_WITHDRAW_SLIPPAGE_PCT = 5;
/** Rejections at inclusion after a passing dry run before the run is given up. */
export const MAX_REJECTIONS = 3;
/** The least the destination must gain for the funds to count as arrived: the dry run's landing
 *  less the slippage the program allows the sale, since a sale that slips further fails the
 *  program on Asset Hub and lands nothing. The dotUSD tier makes no sale, and the same margin
 *  covers Asset Hub's fee moving between the dry run and inclusion. */
export const landingFloor = (landed: bigint, slippagePct: number): bigint =>
  landed - (landed * BigInt(Math.round(slippagePct * 100))) / 10_000n;

/** Terminal: the chain rejected the transaction at inclusion MAX_REJECTIONS times after its dry
 *  run passed each time. Something the dry run cannot see differs at inclusion. */
export class WithdrawRejectedError extends Error {
  constructor(
    readonly call: TickCall | "sweep" | "pay",
    readonly reason: string,
  ) {
    super(`withdrawal given up: ${call} rejected ${MAX_REJECTIONS} times, last: ${reason}`);
    this.name = "WithdrawRejectedError";
  }
}

/** Terminal: the PSM refused the redeem for a reason waiting cannot clear: MAX_PSM_REFUSALS
 *  times with the pair paused, or once with the fee moved past the frozen `max_fee` or an amount
 *  the pallet will not take. The CASH is still on the key on Asset Hub, and a resume with a fresh
 *  count tries again, or the user's switch sells it on the pool. */
export class WithdrawHeldError extends Error {
  constructor(
    readonly reason: string,
    readonly kind: PsmRefusalKind = "unavailable",
  ) {
    super(
      kind === "will-not-serve"
        ? `withdrawal held: the PSM will not redeem as quoted: ${reason}`
        : `withdrawal held: the PSM refused the redeem ${MAX_PSM_REFUSALS} times, last: ${reason}`,
    );
    this.name = "WithdrawHeldError";
  }
}

/** Cross-tick memory for one withdrawal. The driver persists it; `withdrawTickOnce` mutates it. */
export interface WithdrawTickState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** Rejections at inclusion so far. */
  rejections: number;
  /** Set once the XCM landed on People; holds the run in await-arrival. */
  submitted: boolean;
  /** The destination's balance in the landing asset on Asset Hub, read just before the XCM, or
   *  on the PSM tier the redeem, left; what the arrival adds to. */
  destinationBefore: bigint | null;
  /** What the Asset Hub dry run credited to the destination, in the landing asset, for the XCM
   *  that left; on the PSM tier, what the redeem pays out. */
  expectedLanding: bigint | null;
  /** When the first tick saw CASH (ms); null while the payment is still awaited. */
  fundsSeenAt: number | null;
  /** PSM refusals of the redeem the pair's pause explains; MAX_PSM_REFUSALS hold the run. A
   *  shortfall of room, a transport error or another rejection does not count. */
  psmRefusals: number;
  /** Since when the PSM has had no room for the redeem (ms); null while it fits. The driver keeps
   *  a waiting run off its clock. */
  waitingSince: number | null;
  /** Where the PSM tier's CASH leaves the key on Asset Hub: the PSM, or the pool once the user
   *  chose it from a hold. */
  exit: "psm" | "pool";
  /** Set before the redeem or the pool swap is broadcast; holds the run on its landing. */
  redeemSubmitted: boolean;
}

export const freshWithdrawTickState = (): WithdrawTickState => ({
  attempts: 0,
  rejections: 0,
  submitted: false,
  destinationBefore: null,
  expectedLanding: null,
  fundsSeenAt: null,
  psmRefusals: 0,
  waitingSince: null,
  exit: "psm",
  redeemSubmitted: false,
});

export interface WithdrawTickInput {
  peopleApi: PeopleApi;
  assetHubApi: AssetHubApi;
  /** The disposable key: its People SS58, its public key, and its signer. */
  key: { address: string; publicKeyHex: string; signer: PolkadotSigner };
  /** The Asset Hub account that receives the funds, 32-byte public key hex: the key itself for a
   *  provider rail, which pays the provider from it afterwards. */
  destinationHex: string;
  /** The Asset Hub account that may claim a trapped program; defaults to the key. */
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The People pool's account, whose balances are the reserves. */
  poolAccount: string;
  /** The sale on Asset Hub, as the hand-off froze it: what the destination receives. */
  sale: ConversionRoute;
  slippagePct: number;
  /** How the CASH moves to Asset Hub, as the chains answered through `chooseCashTransfer`; never
   *  decided here. */
  transfer: CashTransfer;
  /** The least the sale must land on the destination, for a withdrawal that has promised a
   *  provider an exact figure out of it. Read before each sizing; a sale whose floor is below it
   *  is refused with CommitmentUnfundableError and nothing leaves People. On the PSM tier the
   *  redeem's net is held to it instead, before it leaves the key. */
  minLanding?: () => Promise<bigint>;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  /** Extra options merged into every submit, after People's signed extension and, for the
   *  swap and the redeem, their CASH fee asset. */
  signOptions?: Record<string, unknown>;
  /** The key's CASH and PAS on People. */
  readKeyOnPeople: (ss58: string) => Promise<{ cash: bigint; pas: bigint }>;
  /** The key's CASH and USDT on Asset Hub at the finalized head, for the PSM tier. */
  readKeyOnAssetHub: (hex: string) => Promise<{ cash: bigint; usdt: bigint }>;
  /** The destination's balance in the landing asset on Asset Hub at the finalized head
   *  (`readDestinationBalance`). */
  readDestinationOnAssetHub: (destinationHex: string) => Promise<bigint>;
  now: () => number;
  onTx?: (info: { call: TickCall; txHash: string; block?: number }) => void;
  onTransientError?: (error: unknown) => void;
  onBeforeSubmit?: (call: TickCall) => Promise<void> | void;
}

export interface WithdrawTickOutcome {
  step: WithdrawStep;
  balances: { cash: bigint; pas: bigint };
  /** A transaction went out and landed ok. */
  submitted: boolean;
  /** The PSM has no room for the redeem: nothing was submitted, and the next tick reads again. */
  waiting?: boolean;
}

/** Counts a rejection at inclusion, and gives the run up at MAX_REJECTIONS. */
function rejected(state: WithdrawTickState, call: TickCall, reason: string): never {
  state.rejections += 1;
  if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError(call, reason);
  throw new Error(`${call} rejected: ${reason}`);
}

/**
 * One reading of the key and at most one action on it. Retryable by calling again; the terminal
 * signals are the returned "done" and a thrown WithdrawRejectedError or WithdrawHeldError.
 */
export async function withdrawTickOnce(
  input: WithdrawTickInput,
  state: WithdrawTickState,
): Promise<WithdrawTickOutcome> {
  const { key } = input;
  const balances = await bounded(
    input.readKeyOnPeople(key.address),
    input.tickTimeoutMs,
    "tick balance read",
  );

  if (state.submitted) {
    if (input.sale.tier === "psm") return exitFromAssetHub(input, state, balances, input.sale);
    // The XCM left People; the funds show on the destination. Without the baseline the arrival
    // cannot be measured, so the run holds here until the driver's bound.
    if (state.destinationBefore === null || state.expectedLanding === null) {
      return { step: "await-arrival", balances, submitted: false };
    }
    const destination = await bounded(
      input.readDestinationOnAssetHub(input.destinationHex),
      input.tickTimeoutMs,
      "destination balance read",
    );
    // Two signals: the key holds no CASH, which only the XCM takes in full, so it executed on
    // People; and the destination gained at least what a successful sale can land. Either alone
    // is not an arrival.
    const cashGone = balances.cash === 0n;
    const landed =
      destination - state.destinationBefore >=
      landingFloor(state.expectedLanding, input.slippagePct);
    return { step: cashGone && landed ? "done" : "await-arrival", balances, submitted: false };
  }

  if (balances.cash === 0n) {
    // Only the XCM empties the key of both assets. Seen CASH, a submit, and now nothing: the
    // XCM landed and its answer was lost. The baseline taken before the submit still measures
    // the arrival.
    if (balances.pas === 0n && state.fundsSeenAt !== null && state.attempts > 0) {
      state.submitted = true;
      return { step: "await-arrival", balances, submitted: false };
    }
    return { step: "await-cash", balances, submitted: false };
  }
  if (state.fundsSeenAt === null) state.fundsSeenAt = input.now();

  // The swap pays in CASH; the XCM pays in PAS. Both pass People's signed extension.
  const swapOptions = { ...PEOPLE_TX_OPTIONS, ...input.signOptions };
  const xcmOptions = {
    customSignedExtensions: PEOPLE_TX_OPTIONS.customSignedExtensions,
    ...input.signOptions,
  };

  // No PAS on the key yet: buy the fees' PAS first. PAS on the key: the swap is done, size and
  // prove the XCM. A sizing that finds the PAS short after all sends the run back to the swap.
  const needsSwap = balances.pas === 0n;
  if (!needsSwap) {
    try {
      // The PSM tier holds its redeem to the promised floor instead, on Asset Hub.
      const minLanding =
        input.minLanding === undefined || input.sale.tier === "psm"
          ? undefined
          : await bounded(input.minLanding(), input.tickTimeoutMs, "payment floor read");
      const sizing = await bounded(
        sizeXcm({
          peopleApi: input.peopleApi,
          assetHubApi: input.assetHubApi,
          key: { address: key.address, publicKeyHex: key.publicKeyHex },
          cashOnKey: balances.cash,
          pasOnKey: balances.pas,
          destinationHex: input.destinationHex,
          claimerHex: input.claimerHex,
          assetHubParaId: input.assetHubParaId,
          peopleParaId: input.peopleParaId,
          sale: input.sale,
          slippagePct: input.slippagePct,
          transfer: input.transfer,
          ...(minLanding === undefined ? {} : { minLanding }),
        }),
        input.tickTimeoutMs,
        "withdrawal sizing",
      );
      const tx = buildWithdrawXcm(input.peopleApi, sizing.args);
      // Read before the submit, so what the XCM adds is measured from what was there. Set before
      // the driver persists, so a submit whose answer is lost keeps its baseline. The PSM tier
      // lands on the key and takes its baseline at the redeem.
      if (input.sale.tier !== "psm") {
        state.destinationBefore = await bounded(
          input.readDestinationOnAssetHub(input.destinationHex),
          input.tickTimeoutMs,
          "destination balance read",
        );
        state.expectedLanding = sizing.landed;
      }
      await input.onBeforeSubmit?.("withdraw");
      // Counted before the broadcast, so a submit whose answer is lost is still counted.
      state.attempts += 1;
      const res = await bounded(
        tx.signAndSubmit(key.signer, xcmOptions as never),
        input.submitTimeoutMs,
        "withdrawal submit",
      );
      input.onTx?.({ call: "withdraw", txHash: res.txHash, block: res.block?.number });
      if (!res.ok) {
        rejected(
          state,
          "withdraw",
          describeDispatchError(res.dispatchError, { message: withdrawMessage(sizing.args) }),
        );
      }
      state.submitted = true;
      return { step: "convert", balances, submitted: true };
    } catch (error) {
      if (!(error instanceof NeedsSwapError)) throw error;
      input.onTransientError?.(error);
    }
  }

  const swap = await bounded(
    sizeSwap({
      peopleApi: input.peopleApi,
      key: { address: key.address, publicKeyHex: key.publicKeyHex },
      poolAccount: input.poolAccount,
      cashBalance: balances.cash,
      destinationHex: input.destinationHex,
      claimerHex: input.claimerHex,
      assetHubParaId: input.assetHubParaId,
      peopleParaId: input.peopleParaId,
      sale: input.sale,
      transfer: input.transfer,
    }),
    input.tickTimeoutMs,
    "swap sizing",
  );
  await input.onBeforeSubmit?.("swap");
  state.attempts += 1;
  const res = await bounded(
    buildSwap(input.peopleApi, swap).signAndSubmit(key.signer, swapOptions as never),
    input.submitTimeoutMs,
    "swap submit",
  );
  input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number });
  if (!res.ok) rejected(state, "swap", describeDispatchError(res.dispatchError));
  return { step: "swap", balances, submitted: true };
}

/**
 * The PSM tier once its XCM has left People: waits for the CASH to show on the key's Asset Hub
 * account, then redeems it through the PSM, or sells it on the pool when the user chose that,
 * and reads the stable's arrival. Idempotent by balance: the CASH is on the key until the exit
 * takes it, and a lost answer is read back from the key and the landing.
 */
async function exitFromAssetHub(
  input: WithdrawTickInput,
  state: WithdrawTickState,
  balances: { cash: bigint; pas: bigint },
  route: PsmRoute,
): Promise<WithdrawTickOutcome> {
  const { key, assetHubApi } = input;
  const onKey = await bounded(
    input.readKeyOnAssetHub(key.publicKeyHex),
    input.tickTimeoutMs,
    "key read on Asset Hub",
  );
  if (!state.redeemSubmitted && onKey.cash === 0n) {
    return { step: "await-arrival", balances, submitted: false };
  }
  // A provider rail lands on the key itself and pays the provider from there, so the stable
  // stays where the redeem puts it.
  const toSelf = input.destinationHex === key.publicKeyHex;
  const readLanding = (): Promise<bigint> =>
    toSelf
      ? Promise.resolve(onKey.usdt)
      : bounded(
          input.readDestinationOnAssetHub(input.destinationHex),
          input.tickTimeoutMs,
          "destination balance read",
        );
  const floors = await bounded(
    readRedeemFloors(assetHubApi, route),
    input.tickTimeoutMs,
    "redeem floors read",
  );
  // Below the PSM's minimum nothing can leave the key through it: what is there is what the exit
  // left behind, so the exit landed or is landing. CASH still there says the submit never did.
  if (state.redeemSubmitted && onKey.cash < floors.minSwapAmount) {
    if (state.destinationBefore === null || state.expectedLanding === null) {
      return { step: "redeem", balances, submitted: false };
    }
    const landed = (await readLanding()) - state.destinationBefore >= state.expectedLanding;
    return { step: landed ? "done" : "redeem", balances, submitted: false };
  }

  const waiting = (): WithdrawTickOutcome => {
    state.waitingSince ??= input.now();
    return { step: "redeem", balances, submitted: false, waiting: true };
  };
  const call: TickCall = state.exit === "psm" ? "redeem" : "pool-exit";
  /** The PSM's own refusal is waited out, counted or held by its kind; any other is a
   *  rejection. */
  const refusal = (dispatchError: unknown): WithdrawTickOutcome => {
    const reason = describeDispatchError(dispatchError);
    const kind = psmRefusalKind(dispatchError);
    if (kind === "capacity") return waiting();
    if (kind === "will-not-serve") throw new WithdrawHeldError(reason, kind);
    if (kind === "unavailable") {
      state.psmRefusals += 1;
      if (state.psmRefusals >= MAX_PSM_REFUSALS) throw new WithdrawHeldError(reason);
      throw new Error(`${call} refused: ${reason}`);
    }
    return rejected(state, call, reason);
  };

  // The fee grows with the call's length, not its figures, so the key's whole balance stands in
  // for the amounts still unknown.
  const deliverTo = addressOf(input.destinationHex);
  const probe: ExitCall =
    state.exit === "psm"
      ? buildRedeemBatch(assetHubApi, {
          route,
          cashIn: onKey.cash,
          ...(toSelf ? {} : { deliverTo }),
        })
      : buildPoolExit(assetHubApi, { route, cashIn: onKey.cash, minOut: onKey.cash, deliverTo });
  const feeCash = await bounded(
    estimateRedeemFeeCash(assetHubApi, probe, key.address),
    input.tickTimeoutMs,
    "redeem fee estimate",
  );
  let exit: ExitCall;
  let net: bigint;
  if (state.exit === "psm") {
    const sized = sizeRedeem(onKey.cash, feeCash, route, floors);
    // The PSM redeems only against the pair's debt. Short of the net, the run waits where it is,
    // with nothing spent and without bound: room comes back with every mint.
    const capacity = await bounded(
      readRedeemCapacity(assetHubApi, route.external),
      input.tickTimeoutMs,
      "PSM capacity read",
    );
    if (capacity < sized.net) return waiting();
    net = sized.net;
    exit = buildRedeemBatch(assetHubApi, {
      route,
      cashIn: sized.cashIn,
      ...(toSelf ? {} : { deliverTo }),
    });
  } else {
    const cashIn = cashToExit(onKey.cash, feeCash, floors);
    const quote = await bounded(
      quotePoolExit(assetHubApi, route, cashIn),
      input.tickTimeoutMs,
      "pool exit quote",
    );
    net = lessHeadroom(quote, input.slippagePct);
    exit = buildPoolExit(assetHubApi, { route, cashIn, minOut: net, deliverTo });
  }
  state.waitingSince = null;
  // A withdrawal that promised a provider an exact figure needs the exit to pay it.
  if (input.minLanding !== undefined) {
    const minLanding = await bounded(input.minLanding(), input.tickTimeoutMs, "payment floor read");
    if (net < minLanding) throw new CommitmentUnfundableError(net, minLanding);
  }
  try {
    await bounded(
      dryRunRedeem(assetHubApi, exit, key.address),
      input.tickTimeoutMs,
      "exit dry run",
    );
  } catch (error) {
    if (error instanceof ProgramRejectedError) return refusal(error.dispatchError);
    throw error;
  }
  // Read before the submit, so what the exit adds is measured from what was there. Set before
  // the driver persists, so a submit whose answer is lost keeps its baseline.
  state.destinationBefore = await readLanding();
  state.expectedLanding = net;
  state.redeemSubmitted = true;
  await input.onBeforeSubmit?.(call);
  state.attempts += 1;
  const res = await bounded(
    exit.signAndSubmit(key.signer, { ...ASSET_HUB_CASH_TX_OPTIONS, ...input.signOptions } as never),
    input.submitTimeoutMs,
    `${call} submit`,
  );
  input.onTx?.({ call, txHash: res.txHash, block: res.block?.number });
  if (!res.ok) {
    // Included and refused: the batch rolled back whole, and the CASH is still on the key.
    state.redeemSubmitted = false;
    return refusal(res.dispatchError);
  }
  return { step: "redeem", balances, submitted: true };
}
