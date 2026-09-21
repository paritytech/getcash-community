// The withdrawal pipeline: moves the CASH a disposable key holds on People to a destination on
// Asset Hub as PAS, in two transactions signed by the key. The host pays the key; this waits for
// that CASH, buys the PAS the fees need, sizes and proves the XCM, submits it once, and waits for
// the PAS to show on the destination.
//
// EVERYTHING THE KEY HOLDS LEAVES. The XCM is sized from the key's whole CASH balance after the
// swap, read to the unit, and the PAS left for the transaction fee's headroom is reaped with the
// account.
//
// ARRIVAL IS A BALANCE READ AT THE HEAD, like every other read here. The destination account is
// not ours, so its balance is measured against a baseline taken just before the XCM leaves, and
// the arrival is what the Asset Hub dry run said would land, less the slippage the program
// itself allows: a sale that slips further fails the program, so nothing less can be a landing.
// The key must hold no CASH too, which says the XCM executed on People; a deposit from
// elsewhere alone does not count. Nothing is followed through block history: hosts serve the
// current head and nothing older, and a run that resumes after a reload has no memory but the
// persisted state. A program that fails on Asset Hub traps its assets there and never shows on
// the destination; the run holds until the driver's bound, and the claimer named in the program
// can recover the assets.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the key's CASH and PAS and acts at most once.
// PAS on the key means the swap happened; the XCM is next. A reload resumes from the persisted
// state. A tick that throws is retried on the next tick. Terminal is a transaction rejected at
// inclusion after the dry run passed, three times over, since each rejection costs a fee and the
// same transaction will not pass on the fourth try.

import type { PolkadotSigner } from "polkadot-api";
import { describeDispatchError } from "@getsome/funding";
import { bounded } from "./bounded";
import { PEOPLE_TX_OPTIONS } from "./paseo";
import { NeedsSwapError, sizeSwap, sizeXcm, type AssetHubApi } from "./fees";
import { buildSwap, buildWithdrawXcm, withdrawMessage, type PeopleApi } from "./program";

/** 'swap' buys the PAS the fees need; 'convert' submits the XCM; 'await-arrival' holds while the
 *  PAS has not shown on the destination. */
export type WithdrawStep = "await-cash" | "swap" | "convert" | "await-arrival" | "done";

/** Bound on a tick's chain reads and dry runs. */
export const DEFAULT_WITHDRAW_TICK_TIMEOUT_MS = 30_000;
/** Bound on a submitted transaction's resolution. */
export const DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS = 180_000;
/** Headroom below the quoted sale on Asset Hub before the program fails there. */
export const DEFAULT_WITHDRAW_SLIPPAGE_PCT = 5;
/** Rejections at inclusion after a passing dry run before the run is given up. */
export const MAX_REJECTIONS = 3;
/** The least the destination must gain for the PAS to count as arrived: the dry run's landing
 *  less the slippage the program allows the sale, since a sale that slips further fails the
 *  program on Asset Hub and lands nothing. */
export const landingFloor = (landed: bigint, slippagePct: number): bigint =>
  landed - (landed * BigInt(Math.round(slippagePct * 100))) / 10_000n;

/** Terminal: People rejected the transaction at inclusion MAX_REJECTIONS times after its dry run
 *  passed each time. Something the dry run cannot see differs at inclusion. */
export class WithdrawRejectedError extends Error {
  constructor(
    readonly call: "swap" | "withdraw" | "sweep",
    readonly reason: string,
  ) {
    super(`withdrawal given up: ${call} rejected ${MAX_REJECTIONS} times, last: ${reason}`);
    this.name = "WithdrawRejectedError";
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
  /** The destination's PAS on Asset Hub read just before the XCM left; what the arrival adds to. */
  destinationPasBefore: bigint | null;
  /** PAS the Asset Hub dry run credited to the destination, for the XCM that left. */
  expectedLanding: bigint | null;
  /** When the first tick saw CASH (ms); null while the payment is still awaited. */
  fundsSeenAt: number | null;
}

export const freshWithdrawTickState = (): WithdrawTickState => ({
  attempts: 0,
  rejections: 0,
  submitted: false,
  destinationPasBefore: null,
  expectedLanding: null,
  fundsSeenAt: null,
});

export interface WithdrawTickInput {
  peopleApi: PeopleApi;
  assetHubApi: AssetHubApi;
  /** The disposable key: its People SS58, its public key, and its signer. */
  key: { address: string; publicKeyHex: string; signer: PolkadotSigner };
  /** The Asset Hub account that receives the PAS, 32-byte public key hex. */
  destinationHex: string;
  /** The Asset Hub account that may claim a trapped program; defaults to the key. */
  claimerHex?: string;
  assetHubParaId: number;
  peopleParaId: number;
  /** The People pool's account, whose balances are the reserves. */
  poolAccount: string;
  slippagePct: number;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  /** Extra options merged into every submit, after People's signed extension and, for the
   *  swap, its CASH fee asset. */
  signOptions?: Record<string, unknown>;
  /** The key's CASH and PAS on People. */
  readKeyOnPeople: (ss58: string) => Promise<{ cash: bigint; pas: bigint }>;
  /** The destination's free PAS on Asset Hub at the current head. */
  readDestinationOnAssetHub: (destinationHex: string) => Promise<bigint>;
  now: () => number;
  onTx?: (info: { call: "swap" | "withdraw"; txHash: string; block?: number }) => void;
  onTransientError?: (error: unknown) => void;
  onBeforeSubmit?: (call: "swap" | "withdraw") => Promise<void> | void;
}

export interface WithdrawTickOutcome {
  step: WithdrawStep;
  balances: { cash: bigint; pas: bigint };
  /** A transaction went out and landed ok. */
  submitted: boolean;
}

/**
 * One reading of the key and at most one action on it. Retryable by calling again; the terminal
 * signals are the returned "done" and a thrown WithdrawRejectedError.
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
    // The XCM left People; the PAS shows on the destination. Without the baseline the arrival
    // cannot be measured, so the run holds here until the driver's bound.
    if (state.destinationPasBefore === null || state.expectedLanding === null) {
      return { step: "await-arrival", balances, submitted: false };
    }
    const destinationPas = await bounded(
      input.readDestinationOnAssetHub(input.destinationHex),
      input.tickTimeoutMs,
      "destination balance read",
    );
    // Two signals: the key holds no CASH, which only the XCM takes in full, so it executed on
    // People; and the destination gained at least what a successful sale can land. Either alone
    // is not an arrival.
    const cashGone = balances.cash === 0n;
    const landed =
      destinationPas - state.destinationPasBefore >=
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
  const rejected = (call: "swap" | "withdraw", reason: string): never => {
    state.rejections += 1;
    if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError(call, reason);
    throw new Error(`${call} rejected: ${reason}`);
  };

  // No PAS on the key yet: buy the fees' PAS first. PAS on the key: the swap is done, size and
  // prove the XCM. A sizing that finds the PAS short after all sends the run back to the swap.
  const needsSwap = balances.pas === 0n;
  if (!needsSwap) {
    try {
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
          slippagePct: input.slippagePct,
        }),
        input.tickTimeoutMs,
        "withdrawal sizing",
      );
      const tx = buildWithdrawXcm(input.peopleApi, sizing.args);
      // Read before the submit, so what the XCM adds is measured from what was there. Set before
      // the driver persists, so a submit whose answer is lost keeps its baseline.
      state.destinationPasBefore = await bounded(
        input.readDestinationOnAssetHub(input.destinationHex),
        input.tickTimeoutMs,
        "destination balance read",
      );
      state.expectedLanding = sizing.landed;
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
  if (!res.ok) rejected("swap", describeDispatchError(res.dispatchError));
  return { step: "swap", balances, submitted: true };
}
