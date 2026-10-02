// The exact payment: a provider that quoted a fixed figure, a fiat sale through Meld, is paid that
// figure from the key on Asset Hub and nothing else. What the sale landed above it stays on the
// key.
//
// NEVER TWICE. The key keeps funds after this payment, so an empty key cannot say it went out the
// way it does for the sweep. The nonce says it instead. The key signs nothing on Asset Hub before
// this payment (the sale reaches it by XCM, which spends no nonce), so every attempt is signed at
// one nonce, marked in flight before the broadcast, and a second copy is stale. A key past that
// nonce was paid from: the payment stands when the balance fell by at least the amount. A key
// past it that did not fall that far, or past it with nothing in flight, is not decided here. The
// run stops for a human rather than risk paying twice.
//
// A transfer the chain refused at dispatch spent its nonce and moved nothing, so the next attempt
// takes the next one. A dry run before every broadcast keeps that rare.

import type { PolkadotSigner } from "polkadot-api";
import { describeDispatchError, signedOrigin } from "@getsome/funding";
import { bounded } from "./bounded";
import type { AssetHubApi } from "./fees";
import { MAX_REJECTIONS, WithdrawRejectedError } from "./tick";

/** Headroom on the payment's fee estimate, percent. */
export const PAY_FEE_HEADROOM_PCT = 25;

/** Cross-tick memory for the payment. The driver persists it; `payExactOnce` mutates it. */
export interface ExactPayState {
  /** The nonce the payment is signed at: the key's first on Asset Hub, one further for each
   *  attempt the chain refused at dispatch. */
  nonce: number;
  /** An attempt at `nonce` may have left: set before its broadcast. */
  inFlight: boolean;
  /** The key's free PAS when that attempt left, base units. */
  balanceBefore: string | null;
  /** Submits so far, refused ones included. */
  attempts: number;
  /** Refusals at dispatch so far. */
  rejections: number;
}

export const freshExactPayState = (): ExactPayState => ({
  nonce: 0,
  inFlight: false,
  balanceBefore: null,
  attempts: 0,
  rejections: 0,
});

/**
 * Terminal: whether the key paid cannot be told from the chain, so nothing more is sent from it.
 * The key signed on Asset Hub past the payment's nonce and its balance does not show the payment,
 * or it signed with no payment in flight at all.
 */
export class PaymentUnresolvedError extends Error {
  constructor(readonly detail: string) {
    super(`the payment cannot be confirmed, and is not sent again: ${detail}`);
    this.name = "PaymentUnresolvedError";
  }
}

export interface ExactPayInput {
  assetHubApi: AssetHubApi;
  /** The key: its Asset Hub SS58 and its signer. */
  key: { address: string; signer: PolkadotSigner };
  /** The provider's deposit address, SS58. */
  to: string;
  /** Exactly what the provider expects, base units. */
  amount: bigint;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  signOptions?: Record<string, unknown>;
  /** The key's free PAS and its nonce on Asset Hub, at the best head. */
  readKey: () => Promise<{ free: bigint; nonce: number }>;
  /** Runs before the broadcast, so the driver can persist the attempt about to be made. */
  onBeforeSubmit?: () => Promise<void> | void;
  onTx?: (info: { call: "pay"; txHash: string; block?: number }) => void;
}

/** The transfer: `amount` to `to`, the key kept alive with what is left. */
export function buildExactPay(api: AssetHubApi, to: string, amount: bigint) {
  return api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: to }, value: amount });
}

/**
 * The least the key must hold on Asset Hub to pay `amount` to `to`: the amount, the transfer's
 * fee with headroom, and the existential deposit the key keeps. The sale is held to it before
 * anything leaves People.
 */
export async function exactPaymentFloor(
  api: AssetHubApi,
  from: string,
  to: string,
  amount: bigint,
): Promise<bigint> {
  const [fee, ed] = await Promise.all([
    buildExactPay(api, to, amount).getEstimatedFees(from),
    api.constants.Balances.ExistentialDeposit(),
  ]);
  return amount + (fee * BigInt(100 + PAY_FEE_HEADROOM_PCT)) / 100n + ed;
}

/**
 * What the key's nonce says about the payment: `paid` once the key signed past the payment's nonce
 * and its balance fell by the amount, `open` while the key still stands at it. Throws
 * PaymentUnresolvedError for anything else.
 */
function judge(
  key: { free: bigint; nonce: number },
  state: ExactPayState,
  amount: bigint,
): "paid" | "open" {
  if (key.nonce > state.nonce) {
    if (!state.inFlight) {
      throw new PaymentUnresolvedError(
        `the key is at nonce ${key.nonce} on Asset Hub, and no payment was in flight at ${state.nonce}`,
      );
    }
    const fell = BigInt(state.balanceBefore ?? "0") - key.free;
    if (fell >= amount) return "paid";
    throw new PaymentUnresolvedError(
      `the key signed at nonce ${state.nonce} and its balance fell by ${fell}, less than the ${amount} it pays`,
    );
  }
  if (key.nonce < state.nonce) {
    throw new PaymentUnresolvedError(
      `the key is at nonce ${key.nonce} on Asset Hub, behind the payment's ${state.nonce}`,
    );
  }
  return "open";
}

/**
 * Whether an attempt that may already have left did land, from the chain alone. The rail leg asks
 * this before the provider: a provider that already saw the funds may have closed the order, and
 * its record would then read as a sale that was never paid. False with nothing in flight, and
 * while the key still stands at the payment's nonce; throws PaymentUnresolvedError as the payment
 * itself would.
 */
export async function exactPaymentLanded(
  input: Pick<ExactPayInput, "readKey" | "amount" | "tickTimeoutMs">,
  state: ExactPayState,
): Promise<boolean> {
  if (!state.inFlight) return false;
  const key = await bounded(input.readKey(), input.tickTimeoutMs, "key read");
  return judge(key, state, input.amount) === "paid";
}

/**
 * Resolves once the payment is on chain: sent now, or sent earlier and its answer lost. Throws
 * PaymentUnresolvedError when that cannot be told, a WithdrawRejectedError once the chain refused
 * it MAX_REJECTIONS times, and anything else as transient.
 */
export async function payExactOnce(input: ExactPayInput, state: ExactPayState): Promise<void> {
  const key = await bounded(input.readKey(), input.tickTimeoutMs, "key read");
  if (judge(key, state, input.amount) === "paid") return;

  const tx = buildExactPay(input.assetHubApi, input.to, input.amount);
  const dr = await bounded(
    input.assetHubApi.apis.DryRunApi.dry_run_call(
      signedOrigin(input.key.address) as never,
      tx.decodedCall as never,
      5,
    ),
    input.tickTimeoutMs,
    "payment dry run",
  );
  if (!dr.success) throw new Error("not submitted: Asset Hub would not dry-run the payment");
  if (!dr.value.execution_result.success) {
    const reason = describeDispatchError(dr.value.execution_result.value.error);
    throw new Error(`not submitted: the payment fails on Asset Hub: ${reason}`);
  }

  // Marked before the driver persists and before the broadcast, so an attempt whose answer is
  // lost, or whose worker dies mid flight, is still known to have maybe left.
  if (!state.inFlight) state.balanceBefore = key.free.toString();
  state.inFlight = true;
  state.attempts += 1;
  await input.onBeforeSubmit?.();
  const res = await bounded(
    tx.signAndSubmit(input.key.signer, { ...input.signOptions, nonce: state.nonce } as never),
    input.submitTimeoutMs,
    "payment submit",
  );
  input.onTx?.({ call: "pay", txHash: res.txHash, block: res.block?.number });
  if (res.ok) return;
  // Included and refused: the nonce is spent and nothing moved, so the next attempt takes the
  // next nonce.
  state.nonce += 1;
  state.inFlight = false;
  state.balanceBefore = null;
  state.rejections += 1;
  const reason = describeDispatchError(res.dispatchError);
  if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError("pay", reason);
  throw new Error(`payment rejected: ${reason}`);
}
