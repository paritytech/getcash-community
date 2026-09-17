// The withdrawal pipeline: moves the CASH a disposable key holds on People to a destination on
// Asset Hub as PAS, in two transactions signed by the key. The host pays the key; this waits for
// that CASH, buys the PAS the fees need, sizes and proves the XCM, submits it once, and follows
// the message to Asset Hub.
//
// EVERYTHING THE KEY HOLDS LEAVES. The XCM is sized from the key's whole CASH balance after the
// swap, read to the unit, and the PAS left for the transaction fee's headroom is reaped with the
// account.
//
// ARRIVAL IS THE MESSAGE, NOT A BALANCE. The destination account is not ours, so its balance says
// nothing reliable. The submit's Sent event names the message, and Asset Hub's message queue
// reports the message processed, with success or failure. Processed with failure means the
// program trapped its assets on Asset Hub, which ends the run: the claimer named in the program
// can recover them, the pipeline cannot.
//
// BALANCE-DRIVEN AND RE-ENTRANT: every tick reads the key's CASH and PAS and acts at most once.
// PAS on the key means the swap happened; the XCM is next. A reload resumes from the persisted
// state. A tick that throws is retried on the next tick. Terminal are a processed-with-failure
// message and a transaction rejected at inclusion after the dry run passed, three times over,
// since each rejection costs a fee and the same transaction will not pass on the fourth try.

import type { PolkadotSigner } from "polkadot-api";
import { describeDispatchError } from "@getsome/funding";
import { PEOPLE_TX_OPTIONS } from "./paseo";
import { NeedsSwapError, sizeSwap, sizeXcm, type AssetHubApi } from "./fees";
import { buildSwap, buildWithdrawXcm, withdrawMessage, type PeopleApi } from "./program";

/** 'swap' buys the PAS the fees need; 'convert' submits the XCM; 'await-arrival' holds while the
 *  message crosses to Asset Hub. */
export type WithdrawStep = "await-cash" | "swap" | "convert" | "await-arrival" | "done";

/** Bound on a tick's chain reads and dry runs. */
export const DEFAULT_WITHDRAW_TICK_TIMEOUT_MS = 30_000;
/** Bound on a submitted transaction's resolution. */
export const DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS = 180_000;
/** Headroom below the quoted sale on Asset Hub before the program fails there. */
export const DEFAULT_WITHDRAW_SLIPPAGE_PCT = 5;
/** Rejections at inclusion after a passing dry run before the run is given up. */
export const MAX_REJECTIONS = 3;

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Terminal: Asset Hub processed the message and the program failed there, so its assets are
 *  trapped on Asset Hub under the claimer the program named. */
export class WithdrawTrappedError extends Error {
  constructor(
    readonly messageId: string,
    readonly block: number,
  ) {
    super(`withdrawal trapped: Asset Hub failed message ${messageId} at block ${block}`);
    this.name = "WithdrawTrappedError";
  }
}

/** Terminal: People rejected the transaction at inclusion MAX_REJECTIONS times after its dry run
 *  passed each time. Something the dry run cannot see differs at inclusion. */
export class WithdrawRejectedError extends Error {
  constructor(
    readonly call: "swap" | "withdraw",
    readonly reason: string,
  ) {
    super(`withdrawal given up: ${call} rejected ${MAX_REJECTIONS} times, last: ${reason}`);
    this.name = "WithdrawRejectedError";
  }
}

/** What Asset Hub's message queue said about a message, or null while it has not processed it. */
export type MessageOutcome = { success: boolean; block: number } | null;

/** Cross-tick memory for one withdrawal. The driver persists it; `withdrawTickOnce` mutates it. */
export interface WithdrawTickState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** Rejections at inclusion so far. */
  rejections: number;
  /** Set once the XCM landed on People; holds the run in await-arrival. */
  submitted: boolean;
  /** The forwarded message's id from the Sent event, once the XCM landed. */
  messageId: string | null;
  /** Asset Hub blocks up to this one have been searched for the message. */
  scannedToBlock: number | null;
  /** When the first tick saw CASH (ms); null while the payment is still awaited. */
  fundsSeenAt: number | null;
}

export const freshWithdrawTickState = (): WithdrawTickState => ({
  attempts: 0,
  rejections: 0,
  submitted: false,
  messageId: null,
  scannedToBlock: null,
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
  /** The Asset Hub block the message search starts from: the best block at submit time. */
  assetHubBestBlock: () => Promise<number>;
  /** Searches Asset Hub from `fromBlock` for the message's processing. Returns the outcome when
   *  found, and the last block searched either way. */
  findMessageOutcome: (
    messageId: string,
    fromBlock: number,
  ) => Promise<{ outcome: MessageOutcome; scannedTo: number }>;
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

/** The forwarded message's id out of a submit's events: the PolkadotXcm Sent event carries it,
 *  as the hex string papi decodes a 32-byte id to. */
export function messageIdOf(events: readonly unknown[]): string | null {
  for (const ev of events) {
    const e = ev as {
      type?: string;
      value?: { type?: string; value?: { message_id?: unknown } };
    };
    if (e.type !== "PolkadotXcm" || e.value?.type !== "Sent") continue;
    const id = e.value.value?.message_id;
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * One reading of the key and at most one action on it. Retryable by calling again; the terminal
 * signals are the returned "done", a thrown WithdrawTrappedError and a thrown
 * WithdrawRejectedError.
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
    // The XCM landed; follow the message. Without its id the answer to the submit was lost and
    // the message cannot be followed, so the run holds here until the driver's bound.
    if (state.messageId === null || state.scannedToBlock === null) {
      return { step: "await-arrival", balances, submitted: false };
    }
    const { outcome, scannedTo } = await bounded(
      input.findMessageOutcome(state.messageId, state.scannedToBlock + 1),
      input.tickTimeoutMs,
      "message search",
    );
    state.scannedToBlock = Math.max(state.scannedToBlock, scannedTo);
    if (outcome === null) return { step: "await-arrival", balances, submitted: false };
    if (!outcome.success) throw new WithdrawTrappedError(state.messageId, outcome.block);
    return { step: "done", balances, submitted: false };
  }

  if (balances.cash === 0n) {
    // Only the XCM empties the key of both assets. Seen CASH, a submit, and now nothing: the
    // XCM landed and its answer was lost, so its message cannot be followed.
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
      // Read before the submit, so the search window covers the block the message lands in.
      const fromBlock = await bounded(
        input.assetHubBestBlock(),
        input.tickTimeoutMs,
        "asset hub best block",
      );
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
      state.messageId = messageIdOf(res.events);
      state.scannedToBlock = fromBlock - 1;
      if (state.messageId === null) {
        input.onTransientError?.(
          new Error(
            "the XCM landed but its Sent event carried no message id; arrival cannot be followed",
          ),
        );
      }
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
