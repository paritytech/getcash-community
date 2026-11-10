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
// EVERY READ IS AT THE BEST HEAD, and a submit is settled as soon as a best block holds it, as the
// top up does: each step acts on what the step before did, and waiting for finality between them
// added a minute to every withdrawal. A best block can still be replaced. So the XCM's block and
// the exit's are kept, number and hash, and the run is ticked on after it is done until the
// finalized chain is past them (inclusion.ts). A block that stands is let go. Otherwise the key
// says what became of the transaction, as the top up's deposit does: it usually landed in the
// block that took its place, and only one that shows nowhere takes the arrival back and goes out
// again. A swap needs no block kept: no PAS on the key sends it again.
//
// ARRIVAL IS A BALANCE READ AT THE HEAD, like every other read here. The destination account is
// not ours, so its balance in the landing asset is measured against a baseline taken just before
// the XCM leaves, and the arrival is what the Asset Hub dry run said would land, less the
// slippage the program itself allows, or the program's own floor when that is lower: a sale that
// slips further fails the program, so nothing less can be a landing. The key must hold no CASH
// too, which says the XCM executed on People; a deposit from elsewhere alone does not count. The
// redeem's landing is read the same way, exact, since the PSM's rate is fixed. Nothing is followed
// through block history: hosts serve the current head and nothing older, and a run that resumes
// after a reload has no memory but the persisted state. A program that fails on Asset Hub traps
// its assets there and never shows on the destination; the run holds until the driver's bound,
// and the claimer named in the program can recover the assets.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the key's CASH and PAS and acts at most once.
// PAS on the key means the swap happened; the XCM is next; CASH on the key's Asset Hub account
// means the XCM landed and the redeem is next, signed once at the key's nonce there, which says
// whether it went out. A reload resumes from the persisted state. A tick that throws is retried
// on the next tick. Terminal is a transaction rejected at inclusion after the dry run passed,
// three times over, since each rejection costs a fee and the same transaction will not pass on
// the fourth try; and, on the PSM tier, the PSM refusing the redeem three times for a reason
// waiting cannot clear, or once for one no retry can. A PSM short of room is not terminal while
// the pair still mints: the run waits on Asset Hub, spending nothing, until a mint makes room.

import type { PolkadotSigner } from "polkadot-api";
import {
  describeDispatchError,
  includedInBlock,
  MAX_PSM_REFUSALS,
  mintingOpen,
  ProgramRejectedError,
  psmRefusalKind,
  readRedeemCapacity,
  type CashTransfer,
  type ConversionRoute,
  type PsmRefusalKind,
  type PsmRoute,
} from "@getsome/funding";
import { bounded } from "./bounded";
import { finalizedChainOf, settleBlock, type FinalizedChain } from "./inclusion";
import { ASSET_HUB_CASH_TX_OPTIONS, AT_BEST, PEOPLE_TX_OPTIONS } from "./paseo";
import {
  CommitmentUnfundableError,
  lessHeadroom,
  NeedsSwapError,
  saleFloor,
  sizeSwap,
  sizeXcm,
  type AssetHubApi,
  type XcmSizing,
} from "./fees";
import { buildSwap, buildWithdrawXcm, withdrawMessage, type PeopleApi } from "./program";
import { mayStillLand, PAY_MORTAL_PERIOD } from "./mortality";
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
/** Bound on a submitted transaction's inclusion in a best block. */
export const DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS = 180_000;
/** Headroom below the quoted sale on Asset Hub before the program fails there, percent. The sale
 *  is quoted and dry-run on Asset Hub just before the XCM leaves, so the headroom only covers the
 *  move until the program runs there. */
export const DEFAULT_WITHDRAW_SLIPPAGE_PCT = 1;
/** Rejections at inclusion after a passing dry run before the run is given up. */
export const MAX_REJECTIONS = 3;
/** The least the destination must gain for the funds to count as arrived: the dry run's landing
 *  less the slippage the program allows the sale, since a sale that slips further fails the
 *  program on Asset Hub and lands nothing. The dotUSD tier makes no sale, and the same margin
 *  covers Asset Hub's fee moving between the dry run and inclusion. */
export const landingFloor = (landed: bigint, slippagePct: number): bigint =>
  landed - (landed * BigInt(Math.round(slippagePct * 100))) / 10_000n;

/** The most a sale can land: the dry run's landing plus the slippage. The destination is not
 *  ours, so a gain past it also holds a deposit from elsewhere. */
export const landingCeiling = (landed: bigint, slippagePct: number): bigint =>
  landed + (landed * BigInt(Math.round(slippagePct * 100))) / 10_000n;

/** The least the destination must gain for a sized XCM to count as arrived: its landing less the
 *  slippage, or the floor the program holds the sale to when that is lower. A program that runs
 *  lands at least its floor and one that fails lands nothing, so a sale that went through is
 *  never judged lost. The landing also sells the PAS that travelled with the CASH, which a
 *  stable's floor leaves out, so on that tier a sale can complete under the first figure. */
export const arrivalFloor = (sizing: Pick<XcmSizing, "args" | "landed">, slippagePct: number) => {
  const byLanding = landingFloor(sizing.landed, slippagePct);
  const floor = saleFloor(sizing.args.sale);
  return floor !== undefined && floor < byLanding ? floor : byLanding;
};

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
 *  times with the pair paused or short of room with minting stopped, or once with the fee moved
 *  past the frozen `max_fee` or an amount the pallet will not take. The CASH is still on the key
 *  on Asset Hub, and a resume with a fresh count tries again, or the user's switch sells it on
 *  the pool. */
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
  /** An XCM was signed: set before its broadcast. Only then can an empty key mean it landed. */
  xcmSigned: boolean;
  /** The People block the XCM was seen in, kept until the finalized chain settles it. Null once
   *  it is final, and while no XCM is out. */
  xcmBlock: number | null;
  /** That block's hash. Null when the XCM's answer was lost and the empty key alone said it
   *  landed, in that block or an earlier one. */
  xcmHash: string | null;
  /** The arrival was seen. Holds the done while the blocks stand, whatever the destination does
   *  with the funds since; a block that is replaced clears it. */
  arrived: boolean;
  /** What the destination received, in the landing asset, as read when the arrival was seen:
   *  what the user's success screen shows. Null until then. */
  received: bigint | null;
  /** The destination's balance in the landing asset on Asset Hub, read just before the XCM, or
   *  on the PSM tier the redeem, left; what the arrival adds to. */
  destinationBefore: bigint | null;
  /** What the Asset Hub dry run credited to the destination, in the landing asset, for the XCM
   *  that left; on the PSM tier, what the redeem pays out. */
  expectedLanding: bigint | null;
  /** The least the destination must gain for that XCM to count as arrived (`arrivalFloor`);
   *  null on a run submitted before it was kept, which falls back to the landing less the
   *  slippage. */
  arrivalFloor: bigint | null;
  /** When the first tick saw CASH (ms); null while the payment is still awaited. */
  fundsSeenAt: number | null;
  /** PSM refusals of the redeem waiting cannot clear, the pair's pause or a shortfall of room
   *  with minting stopped; MAX_PSM_REFUSALS hold the run. A shortfall the next mint may fill, a
   *  transport error or another rejection does not count. */
  psmRefusals: number;
  /** Since when the PSM has had no room for the redeem (ms); null while it fits. The driver keeps
   *  a waiting run off its clock. */
  waitingSince: number | null;
  /** Where the PSM tier's CASH leaves the key on Asset Hub: the PSM, or the pool once the user
   *  chose it from a hold. */
  exit: "psm" | "pool";
  /** Set before the redeem or the pool swap is broadcast; holds the run on its landing. */
  redeemSubmitted: boolean;
  /** The nonce that exit is signed at, the key's on Asset Hub at the best head just before it;
   *  null while none is in flight. A key past it signed the exit. */
  redeemNonce: number | null;
  /** The block that exit is anchored at: it can land only within PAY_MORTAL_PERIOD blocks of it,
   *  so once the finalized chain is past that with the nonce unmoved, it never will. */
  redeemAnchor: number | null;
  /** The CASH that exit takes off the key, which says whether a key past its nonce ran it or had
   *  it refused (`exitRan`). Null while none is out. */
  redeemCashIn: bigint | null;
  /** The Asset Hub block that exit was seen in, kept until the finalized chain settles it. Null
   *  once it is final and while none is out. */
  redeemBlock: number | null;
  /** That block's hash. Null when the exit's answer was lost and the key alone said it ran, in
   *  that block or an earlier one. */
  redeemHash: string | null;
}

export const freshWithdrawTickState = (): WithdrawTickState => ({
  attempts: 0,
  rejections: 0,
  submitted: false,
  xcmSigned: false,
  xcmBlock: null,
  xcmHash: null,
  arrived: false,
  received: null,
  destinationBefore: null,
  expectedLanding: null,
  arrivalFloor: null,
  fundsSeenAt: null,
  psmRefusals: 0,
  waitingSince: null,
  exit: "psm",
  redeemSubmitted: false,
  redeemNonce: null,
  redeemAnchor: null,
  redeemCashIn: null,
  redeemBlock: null,
  redeemHash: null,
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
  /** Extra options merged into every submit on People, after its signed extension and, for the
   *  swap, its CASH fee asset. */
  signOptions?: Record<string, unknown>;
  /** The best block on Asset Hub the exit is anchored at, read once just before it is signed. An
   *  anchor from People is not valid there, so the two chains' submits never share an option. */
  assetHubAnchor: () => Promise<{ hash: string; number: number }>;
  /** The finalized head's number on Asset Hub. */
  readFinalizedNumber: () => Promise<number>;
  /** The key's CASH and PAS on People, at the best head or the finalized one. Every step reads
   *  the best head; the finalized one only settles an XCM whose block the chain can no longer
   *  vouch for. */
  readKeyOnPeople: (
    ss58: string,
    at: "best" | "finalized",
  ) => Promise<{ cash: bigint; pas: bigint }>;
  /** The key's CASH and USDT on Asset Hub, and its nonce there, at the best head or the finalized
   *  one, for the PSM tier. The finalized one only settles an exit as the XCM's is settled. */
  readKeyOnAssetHub: (
    hex: string,
    at: "best" | "finalized",
  ) => Promise<{ cash: bigint; usdt: bigint; nonce: number }>;
  /** The destination's balance in the landing asset on Asset Hub at the best head
   *  (`readDestinationBalance`). */
  readDestinationOnAssetHub: (destinationHex: string) => Promise<bigint>;
  now: () => number;
  onTx?: (info: { call: TickCall; txHash: string; block?: number; ok: boolean }) => void;
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

/**
 * Whether the finalized chain can vouch for the block a transaction was seen in: "final" when it
 * holds it, "pending" while it is not there yet, and "unsettled" when only the transaction's own
 * effect can tell: the block was replaced, the chain no longer names a block that old, or no
 * block was known, for a lost answer. Then the finalized head is at least that far.
 */
async function vouch(
  chain: FinalizedChain,
  block: number,
  hash: string | null,
  timeoutMs: number,
): Promise<"final" | "pending" | "unsettled"> {
  if (hash !== null) {
    const verdict = await settleBlock(chain, { number: block, hash }, timeoutMs);
    return verdict === "final" || verdict === "pending" ? verdict : "unsettled";
  }
  const finalized = await bounded(chain.number(), timeoutMs, "finalized head read");
  return finalized < block ? "pending" : "unsettled";
}

/**
 * The XCM is in a best block People may yet replace, so its finalized chain has the last word once
 * it is past that block. The block stands: the XCM is final and the block is let go. Otherwise the
 * XCM usually landed in the block that took its place, and the key says so, as the top up's deposit
 * does: the XCM takes all the CASH, so a key empty at the finalized head means it is final. Empty
 * only at the best head, it landed later, and is watched again from there. Holding CASH at both,
 * it never landed: the latch is released and the tick sends again what the key holds.
 */
async function settleXcm(input: WithdrawTickInput, state: WithdrawTickState): Promise<void> {
  const block = state.xcmBlock;
  if (block === null) return;
  const said = await vouch(
    finalizedChainOf(input.peopleApi),
    block,
    state.xcmHash,
    input.tickTimeoutMs,
  );
  if (said === "pending") return;
  const letGo = () => {
    state.xcmBlock = null;
    state.xcmHash = null;
  };
  if (said === "final") return letGo();
  const read = (at: "best" | "finalized") =>
    bounded(input.readKeyOnPeople(input.key.address, at), input.tickTimeoutMs, `key read (${at})`);
  if ((await read("finalized")).cash === 0n) return letGo();
  if ((await read("best")).cash === 0n) {
    state.xcmBlock = await bounded(
      input.peopleApi.query.System.Number.getValue(AT_BEST),
      input.tickTimeoutMs,
      "block number read",
    );
    state.xcmHash = null;
    return;
  }
  letGo();
  state.submitted = false;
  state.arrived = false;
  state.received = null;
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
    input.readKeyOnPeople(key.address, "best"),
    input.tickTimeoutMs,
    "tick balance read",
  );

  // A block that was replaced releases the latch here, and what the key holds is sent again below.
  if (state.submitted) await settleXcm(input, state);
  if (state.submitted) {
    if (input.sale.tier === "psm") return exitFromAssetHub(input, state, balances, input.sale);
    // The arrival was seen and the XCM's block stands: done, whatever the destination has done
    // with the funds since.
    if (state.arrived) return { step: "done", balances, submitted: false };
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
    const gained = destination - state.destinationBefore;
    const landed =
      gained >= (state.arrivalFloor ?? landingFloor(state.expectedLanding, input.slippagePct));
    if (!cashGone || !landed) return { step: "await-arrival", balances, submitted: false };
    // What the sale delivered at the market's price, not what its dry run expected. A gain past
    // what the sale can land holds someone else's deposit too, so the dry run's figure stands in.
    state.arrived = true;
    state.received =
      gained > landingCeiling(state.expectedLanding, input.slippagePct)
        ? state.expectedLanding
        : gained;
    return { step: "done", balances, submitted: false };
  }

  if (balances.cash === 0n) {
    // Only the XCM empties the key of both assets. Seen CASH, an XCM signed, and now nothing: the
    // XCM landed and its answer was lost. The baseline taken before the submit still measures
    // the arrival. With no XCM signed, an empty key is a best block that dropped the payment, and
    // the run waits for it to come back.
    if (
      balances.pas === 0n &&
      state.fundsSeenAt !== null &&
      state.attempts > 0 &&
      state.xcmSigned
    ) {
      // The XCM is in the latest block or an earlier one, with no hash known: the key at the
      // finalized head settles it once that head is there (`settleXcm`).
      state.xcmBlock = await bounded(
        input.peopleApi.query.System.Number.getValue(AT_BEST),
        input.tickTimeoutMs,
        "block number read",
      );
      state.xcmHash = null;
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
        state.arrivalFloor = arrivalFloor(sizing, input.slippagePct);
      }
      state.xcmSigned = true;
      state.arrived = false;
      state.received = null;
      await input.onBeforeSubmit?.("withdraw");
      // Counted before the broadcast, so a submit whose answer is lost is still counted.
      state.attempts += 1;
      const res = await includedInBlock(
        tx.signSubmitAndWatch(key.signer, xcmOptions as never),
        input.submitTimeoutMs,
        "withdrawal submit",
      );
      input.onTx?.({ call: "withdraw", txHash: res.txHash, block: res.block?.number, ok: res.ok });
      if (!res.ok) {
        rejected(
          state,
          "withdraw",
          describeDispatchError(res.dispatchError, { message: withdrawMessage(sizing.args) }),
        );
      }
      // In a best block People may yet replace: kept until the finalized chain settles it.
      state.submitted = true;
      state.xcmBlock = res.block.number;
      state.xcmHash = res.block.hash;
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
  const res = await includedInBlock(
    buildSwap(input.peopleApi, swap).signSubmitAndWatch(key.signer, swapOptions as never),
    input.submitTimeoutMs,
    "swap submit",
  );
  input.onTx?.({ call: "swap", txHash: res.txHash, block: res.block?.number, ok: res.ok });
  if (!res.ok) rejected(state, "swap", describeDispatchError(res.dispatchError));
  return { step: "swap", balances, submitted: true };
}

/** Takes the exit out of flight: nothing of it can land any more. The baseline stays until the
 *  next sizing takes its own. */
function exitNeverLands(state: WithdrawTickState): void {
  state.redeemSubmitted = false;
  state.redeemNonce = null;
  state.redeemAnchor = null;
  state.redeemCashIn = null;
  state.redeemBlock = null;
  state.redeemHash = null;
}

/**
 * Whether the key, read at one head, shows the exit ran: past the exit's nonce, with the CASH the
 * exit takes gone. A run leaves only the fee's unspent margin and the account's minimum; a
 * refusal rolls the batch back and leaves all of it but the fee. The line is half of what the exit
 * takes, so that a fee charged over its estimate cannot pass a refusal off as a run.
 */
const exitRan = (state: WithdrawTickState, key: { nonce: number; cash: bigint }): boolean =>
  state.redeemNonce !== null &&
  state.redeemCashIn !== null &&
  key.nonce > state.redeemNonce &&
  key.cash < state.redeemCashIn / 2n;

/**
 * The exit is in a best block Asset Hub may yet replace, so its finalized chain has the last word
 * once it is past that block. The block stands: the exit is final and the block is let go.
 * Otherwise the key says it, as for the XCM: the exit ran at the finalized head, and it is final;
 * only at the best head, and it is watched again from there; at neither, and the arrival goes
 * with it, while the exit's own settling decides from the nonce what is sent, waiting out its
 * mortality while the key is still at it.
 */
async function settleExitBlock(input: WithdrawTickInput, state: WithdrawTickState): Promise<void> {
  const block = state.redeemBlock;
  if (block === null) return;
  const said = await vouch(
    finalizedChainOf(input.assetHubApi),
    block,
    state.redeemHash,
    input.tickTimeoutMs,
  );
  if (said === "pending") return;
  const letGo = () => {
    state.redeemBlock = null;
    state.redeemHash = null;
  };
  if (said === "final") return letGo();
  const read = (at: "best" | "finalized") =>
    bounded(
      input.readKeyOnAssetHub(input.key.publicKeyHex, at),
      input.tickTimeoutMs,
      `key read on Asset Hub (${at})`,
    );
  if (exitRan(state, await read("finalized"))) return letGo();
  if (exitRan(state, await read("best"))) {
    await watchExitFromBest(input, state);
    return;
  }
  letGo();
  state.arrived = false;
  state.received = null;
}

/**
 * What an exit that ran delivered. The PSM pays its net at a fixed rate, so the redeem's net is
 * exact. The pool pays the market's price, at least its floor: what the landing gained since the
 * exit was sized. The destination is not ours, so where the gain is under the floor it moved
 * some on, and where it is past the quote plus the slippage someone else paid in too; the floor
 * stands in for either.
 */
async function deliveredByExit(
  state: WithdrawTickState,
  readLanding: () => Promise<bigint>,
  slippagePct: number,
): Promise<bigint | null> {
  const net = state.expectedLanding;
  if (state.exit === "psm" || net === null || state.destinationBefore === null) return net;
  const gained = (await readLanding()) - state.destinationBefore;
  // The floor is the quote less the slippage (`lessHeadroom`): the quote back from it.
  const quote = (net * 10_000n) / BigInt(Math.round((100 - slippagePct) * 100));
  return gained >= net && gained <= landingCeiling(quote, slippagePct) ? gained : net;
}

/** An exit that ran with no block known for it is watched from the best block, and settled at
 *  the finalized head by the key (`settleExitBlock`). */
async function watchExitFromBest(input: WithdrawTickInput, state: WithdrawTickState) {
  state.redeemBlock = await bounded(
    input.assetHubApi.query.System.Number.getValue(AT_BEST),
    input.tickTimeoutMs,
    "block number read",
  );
  state.redeemHash = null;
}

/**
 * What the chain says of an exit that was broadcast, whatever became of its answer. A key past
 * the exit's nonce signed it, and the key's CASH says whether it ran (`exitRan`): `done`, or
 * refused at inclusion, and null frees the run to size afresh. The destination is not ours and
 * may already have moved what landed, so its balance is not asked. A key at that nonce has not
 * signed it: the exit may land until its mortality is out, and nothing is sent meanwhile; past it
 * unlanded, it never will, and null again.
 */
async function settleExit(
  input: WithdrawTickInput,
  state: WithdrawTickState,
  key: { nonce: number; cash: bigint },
): Promise<"done" | "redeem" | null> {
  const { nonce } = key;
  const pinned = state.redeemNonce;
  if (pinned !== null && nonce < pinned) {
    throw new Error(`the key is at nonce ${nonce} on Asset Hub, behind the exit's ${pinned}`);
  }
  if (pinned !== null && nonce === pinned) {
    const finalized = await bounded(
      input.readFinalizedNumber(),
      input.tickTimeoutMs,
      "finalized head read",
    );
    if (state.redeemAnchor === null || mayStillLand(state.redeemAnchor, finalized)) return "redeem";
    // Read again after the finalized head, so the best head holds every block the exit could have
    // landed in. A nonce that moved since is settled on the next tick.
    const again = await bounded(
      input.readKeyOnAssetHub(input.key.publicKeyHex, "best"),
      input.tickTimeoutMs,
      "key read on Asset Hub",
    );
    if (again.nonce !== pinned) return "redeem";
    exitNeverLands(state);
    return null;
  }
  if (exitRan(state, key)) return "done";
  if (pinned === null) return "redeem";
  // Refused at inclusion with the answer lost: the batch rolled back whole and the nonce is
  // spent. Not counted as a rejection, since the reason is unknown; the dry run before the next
  // submit catches a refusal that stands.
  exitNeverLands(state);
  return null;
}

/**
 * The PSM tier once its XCM has left People: waits for the CASH to show on the key's Asset Hub
 * account, then redeems it through the PSM, or sells it on the pool when the user chose that,
 * and reads the stable's arrival. The exit is signed once at the key's nonce, under a mortality:
 * the CASH stays on the key until the exit takes it, so a lost answer is settled from the nonce
 * and the key's CASH, and nothing is sized or sent again while that exit can still land.
 */
async function exitFromAssetHub(
  input: WithdrawTickInput,
  state: WithdrawTickState,
  balances: { cash: bigint; pas: bigint },
  route: PsmRoute,
): Promise<WithdrawTickOutcome> {
  const { key, assetHubApi } = input;
  const onKey = await bounded(
    input.readKeyOnAssetHub(key.publicKeyHex, "best"),
    input.tickTimeoutMs,
    "key read on Asset Hub",
  );
  await settleExitBlock(input, state);
  // The stable was seen landed and the blocks stand: done, whatever became of it since.
  if (state.arrived) return { step: "done", balances, submitted: false };
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
  if (state.redeemSubmitted) {
    const settled = await settleExit(input, state, onKey);
    if (settled === "done") {
      state.received = await deliveredByExit(state, readLanding, input.slippagePct);
      // Its answer lost, or its block given up on: no block is known, so it is watched from the
      // best block, as a lost XCM is.
      if (state.redeemBlock === null) await watchExitFromBest(input, state);
      // Last, so a read that fails above leaves the exit to be settled again on the next tick.
      state.arrived = true;
    }
    if (settled !== null) return { step: settled, balances, submitted: false };
  }
  const floors = await bounded(
    readRedeemFloors(assetHubApi, route),
    input.tickTimeoutMs,
    "redeem floors read",
  );

  const waiting = (): WithdrawTickOutcome => {
    state.waitingSince ??= input.now();
    return { step: "redeem", balances, submitted: false, waiting: true };
  };
  const call: TickCall = state.exit === "psm" ? "redeem" : "pool-exit";
  /** A refusal waiting cannot clear: counted, and the run held at MAX_PSM_REFUSALS. */
  const unavailable = (reason: string): never => {
    state.psmRefusals += 1;
    if (state.psmRefusals >= MAX_PSM_REFUSALS) throw new WithdrawHeldError(reason);
    throw new Error(`${call} refused: ${reason}`);
  };
  /** The PSM's own refusal is waited out, counted or held by its kind; any other is a
   *  rejection. */
  const refusal = (dispatchError: unknown): WithdrawTickOutcome => {
    const reason = describeDispatchError(dispatchError);
    const kind = psmRefusalKind(dispatchError);
    if (kind === "capacity") return waiting();
    if (kind === "will-not-serve") throw new WithdrawHeldError(reason, kind);
    if (kind === "unavailable") return unavailable(reason);
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
  let takes: bigint;
  if (state.exit === "psm") {
    const sized = sizeRedeem(onKey.cash, feeCash, route, floors);
    // The PSM redeems only against the pair's debt. Short of the net, the run waits where it is,
    // with nothing spent and without bound, since room comes back with every mint; but only
    // while the pair still mints. The route admits a redeem with minting stopped, and then no
    // mint will ever make room, so the shortfall is refused as the pair's pause is: counted,
    // and held at MAX_PSM_REFUSALS, the run back on the driver's clock.
    const capacity = await bounded(
      readRedeemCapacity(assetHubApi, route.external),
      input.tickTimeoutMs,
      "PSM capacity read",
    );
    if (capacity < sized.net) {
      const minting = await bounded(
        mintingOpen(assetHubApi, route.external),
        input.tickTimeoutMs,
        "PSM minting status read",
      );
      if (minting) return waiting();
      state.waitingSince = null;
      return unavailable("the PSM has no room for the redeem and minting is stopped");
    }
    net = sized.net;
    takes = sized.cashIn;
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
    takes = cashIn;
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
  // the driver persists, with the nonce and the anchor the exit is signed under, so a submit
  // whose answer is lost keeps its baseline and is settled before another is sized.
  const anchor = await bounded(input.assetHubAnchor(), input.tickTimeoutMs, "anchor read");
  state.destinationBefore = await readLanding();
  state.expectedLanding = net;
  state.redeemNonce = onKey.nonce;
  state.redeemAnchor = anchor.number;
  state.redeemCashIn = takes;
  state.redeemSubmitted = true;
  await input.onBeforeSubmit?.(call);
  state.attempts += 1;
  const res = await includedInBlock(
    exit.signSubmitAndWatch(key.signer, {
      ...ASSET_HUB_CASH_TX_OPTIONS,
      at: anchor.hash,
      nonce: state.redeemNonce,
      mortality: { mortal: true, period: PAY_MORTAL_PERIOD },
    } as never),
    input.submitTimeoutMs,
    `${call} submit`,
  );
  input.onTx?.({ call, txHash: res.txHash, block: res.block?.number, ok: res.ok });
  if (!res.ok) {
    // Included and refused: the batch rolled back whole, the CASH is still on the key, and the
    // nonce is spent.
    exitNeverLands(state);
    return refusal(res.dispatchError);
  }
  // In a best block Asset Hub may yet replace: kept until the finalized chain settles it.
  state.redeemBlock = res.block.number;
  state.redeemHash = res.block.hash;
  return { step: "redeem", balances, submitted: true };
}
