// The sweep: everything the key holds on Asset Hub in the token the sale landed moved to the
// provider's account in one transfer that empties and closes the key. The last thing a withdrawal
// does with its key.
//
// IDEMPOTENT BY BALANCE. The key holds the token until the transfer lands, and nothing after. A
// tick that finds the key empty after a submit takes the sweep as done, whatever became of the
// submit's answer. A tick that finds it empty before any submit has nothing to move and says so.
//
// A rejection at inclusion costs a fee and is counted; the third gives the run up, as the message
// leg does, since the same transfer will not pass on the fourth try.
//
// DONE AT THE BEST BLOCK. The sweep resolves once a best block holds it, and that block is kept
// on the state for the driver to watch until it is final (inclusion.ts). The key is reaped behind
// the sweep and its nonce starts over, so only the block's hash can say the sweep still stands.

import type { PolkadotSigner } from "polkadot-api";
import type { TokenSpec } from "@getsome/core";
import { describeDispatchError, includedInBlock } from "@getsome/funding";
import { bounded } from "./bounded";
import type { AssetHubApi } from "./fees";
import type { SeenBlock } from "./inclusion";
import { MAX_REJECTIONS, WithdrawRejectedError } from "./tick";

/** Cross-tick memory for the sweep. The driver persists it; `sweepOnce` mutates it. */
export interface SweepState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** Rejections at inclusion so far. */
  rejections: number;
  /** The best block the sweep was seen in, kept until the finalized chain settles it. Absent
   *  before any, once it is final, and for one whose answer was lost. */
  seen?: SeenBlock | null;
}

export const freshSweepState = (): SweepState => ({ attempts: 0, rejections: 0 });

export interface SweepInput {
  assetHubApi: AssetHubApi;
  key: { signer: PolkadotSigner };
  /** The Asset Hub account that receives everything, SS58. */
  to: string;
  /** The token the key holds and the channel takes: the native, or a pallet-assets token. */
  token: TokenSpec;
  /** Bound on the balance read. */
  tickTimeoutMs: number;
  /** Bound on the submit's resolution. */
  submitTimeoutMs: number;
  signOptions?: Record<string, unknown>;
  /** The key's balance in `token` on Asset Hub at the best head. */
  readKeyOnAssetHub: () => Promise<bigint>;
  /** Runs before the broadcast, so the driver can persist the attempt about to be made. */
  onBeforeSubmit?: () => Promise<void> | void;
  onTx?: (info: { call: "sweep"; txHash: string; block?: number; ok: boolean }) => void;
}

/** The whole balance in `token` to `to`, the key reaped behind it. */
export function buildSweep(api: AssetHubApi, to: string, token: TokenSpec) {
  const dest = { type: "Id" as const, value: to };
  if (token.assetHubId === undefined) {
    return api.tx.Balances.transfer_all({ dest, keep_alive: false });
  }
  return api.tx.Assets.transfer_all({ id: token.assetHubId, dest, keep_alive: false });
}

/**
 * Resolves once the key is empty: the transfer landed now, or landed earlier and its answer was
 * lost. Throws on anything else, a WithdrawRejectedError once inclusion has refused it
 * MAX_REJECTIONS times.
 */
export async function sweepOnce(input: SweepInput, state: SweepState): Promise<void> {
  const held = await bounded(input.readKeyOnAssetHub(), input.tickTimeoutMs, "key balance read");
  if (held === 0n) {
    // Its answer was lost. Not watched to finality: a swap's refund can fill the key the sweep
    // emptied, so a later read of the key could not tell the sweep never left.
    if (state.attempts > 0) return;
    throw new Error("nothing on the key to sweep");
  }
  // Counted before the driver persists and before the broadcast, so a submit whose answer is
  // lost, or whose worker dies mid flight, is still counted and the empty key reads as swept.
  state.attempts += 1;
  await input.onBeforeSubmit?.();
  const res = await includedInBlock(
    buildSweep(input.assetHubApi, input.to, input.token).signSubmitAndWatch(
      input.key.signer,
      input.signOptions as never,
    ),
    input.submitTimeoutMs,
    "sweep submit",
  );
  input.onTx?.({ call: "sweep", txHash: res.txHash, block: res.block?.number, ok: res.ok });
  if (!res.ok) {
    state.rejections += 1;
    const reason = describeDispatchError(res.dispatchError);
    if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError("sweep", reason);
    throw new Error(`sweep rejected: ${reason}`);
  }
  // In a best block the chain may yet replace: the driver watches it until it is final.
  state.seen = { number: res.block.number, hash: res.block.hash };
}
