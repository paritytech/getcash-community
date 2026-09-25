// The sweep: everything the key holds on Asset Hub moved to the provider's account in one
// transfer that empties and closes the key. The last thing a withdrawal does with its key.
//
// IDEMPOTENT BY BALANCE. The key holds PAS until the transfer lands, and nothing after. A tick
// that finds the key empty after a submit takes the sweep as done, whatever became of the
// submit's answer. A tick that finds it empty before any submit has nothing to move and says so.
//
// A rejection at inclusion costs a fee and is counted; the third gives the run up, as the message
// leg does, since the same transfer will not pass on the fourth try.

import type { PolkadotSigner } from "polkadot-api";
import { describeDispatchError } from "@getsome/funding";
import { bounded } from "./bounded";
import type { AssetHubApi } from "./fees";
import { MAX_REJECTIONS, WithdrawRejectedError } from "./tick";

/** Cross-tick memory for the sweep. The driver persists it; `sweepOnce` mutates it. */
export interface SweepState {
  /** Submits so far, rejected ones included. */
  attempts: number;
  /** Rejections at inclusion so far. */
  rejections: number;
}

export const freshSweepState = (): SweepState => ({ attempts: 0, rejections: 0 });

export interface SweepInput {
  assetHubApi: AssetHubApi;
  key: { signer: PolkadotSigner };
  /** The Asset Hub account that receives everything, SS58. */
  to: string;
  /** Bound on the balance read. */
  tickTimeoutMs: number;
  /** Bound on the submit's resolution. */
  submitTimeoutMs: number;
  signOptions?: Record<string, unknown>;
  /** The key's free PAS on Asset Hub. */
  readKeyOnAssetHub: () => Promise<bigint>;
  /** Runs before the broadcast, so the driver can persist the attempt about to be made. */
  onBeforeSubmit?: () => Promise<void> | void;
  onTx?: (info: { call: "sweep"; txHash: string; block?: number }) => void;
}

/** The whole balance to `to`, the key reaped behind it. */
export function buildSweep(api: AssetHubApi, to: string) {
  return api.tx.Balances.transfer_all({ dest: { type: "Id", value: to }, keep_alive: false });
}

/**
 * Resolves once the key is empty: the transfer landed now, or landed earlier and its answer was
 * lost. Throws on anything else, a WithdrawRejectedError once inclusion has refused it
 * MAX_REJECTIONS times.
 */
export async function sweepOnce(input: SweepInput, state: SweepState): Promise<void> {
  const pas = await bounded(input.readKeyOnAssetHub(), input.tickTimeoutMs, "key balance read");
  if (pas === 0n) {
    if (state.attempts > 0) return;
    throw new Error("nothing on the key to sweep");
  }
  // Counted before the driver persists and before the broadcast, so a submit whose answer is
  // lost, or whose worker dies mid flight, is still counted and the empty key reads as swept.
  state.attempts += 1;
  await input.onBeforeSubmit?.();
  const res = await bounded(
    buildSweep(input.assetHubApi, input.to).signAndSubmit(
      input.key.signer,
      input.signOptions as never,
    ),
    input.submitTimeoutMs,
    "sweep submit",
  );
  input.onTx?.({ call: "sweep", txHash: res.txHash, block: res.block?.number });
  if (!res.ok) {
    state.rejections += 1;
    const reason = describeDispatchError(res.dispatchError);
    if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError("sweep", reason);
    throw new Error(`sweep rejected: ${reason}`);
  }
}
