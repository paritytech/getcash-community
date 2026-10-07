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
import type { TokenSpec } from "@getsome/core";
import {
  describeDispatchError,
  isStable,
  priceNativeFeeIn,
  signedOrigin,
  stableTxOptions,
  type Stable,
} from "@getsome/funding";
import { bounded } from "./bounded";
import type { AssetHubApi } from "./fees";
import { MAX_REJECTIONS, WithdrawRejectedError } from "./tick";

/** Headroom on the payment's fee estimate, percent. */
export const PAY_FEE_HEADROOM_PCT = 25;

/** The least a sale's key must hold of `token` once the provider is paid for the worker to send it
 *  home, base units: a tenth of the token. Below it the fees of the way back take most of it, and
 *  it stays on the key. */
export const residueReturnFloor = (token: TokenSpec): bigint => 10n ** BigInt(token.decimals) / 10n;

/** The stable the key pays in and is charged in, by its token-table symbol and pallet-assets id;
 *  null for the native. A pallet-assets token that is not a stable cannot pay its own fee, so no
 *  payment is made in it. */
function stableOf(token: TokenSpec): { symbol: Stable; assetHubId: number } | null {
  if (token.assetHubId === undefined) return null;
  if (!isStable(token.symbol)) throw new Error(`no exact payment can be made in ${token.symbol}`);
  return { symbol: token.symbol, assetHubId: token.assetHubId };
}

/** Blocks a payment stays valid after the block it is anchored at. Signed into the payment
 *  rather than left to papi's default, since `exactPaymentLanded` counts on it to call an
 *  unlanded attempt dead. */
const PAY_MORTAL_PERIOD = 64;

/** Cross-tick memory for the payment. The driver persists it; `payExactOnce` mutates it. */
export interface ExactPayState {
  /** The nonce the payment is signed at: the key's first on Asset Hub, one further for each
   *  attempt the chain refused at dispatch. */
  nonce: number;
  /** An attempt at `nonce` may have left: set before its broadcast. */
  inFlight: boolean;
  /** The key's balance in the token when that attempt left, base units. */
  balanceBefore: string | null;
  /** The block that attempt is anchored at: it can land only within PAY_MORTAL_PERIOD blocks of
   *  it, so once the finalized chain is past that with the nonce unmoved, it never will. */
  anchor?: number | null;
  /** Refusals at dispatch so far. */
  rejections: number;
}

export const freshExactPayState = (): ExactPayState => ({
  nonce: 0,
  inFlight: false,
  balanceBefore: null,
  anchor: null,
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
  /** Exactly what the provider expects, base units of `token`. */
  amount: bigint;
  /** The token the key holds and the provider takes: the native, or a stable, which pays the
   *  transfer's fee itself. */
  token: TokenSpec;
  tickTimeoutMs: number;
  submitTimeoutMs: number;
  signOptions?: Record<string, unknown>;
  /** The number of the block `signOptions` anchors the payment at. */
  anchorNumber?: number;
  /** The key's balance in `token` and its nonce on Asset Hub, at the finalized head. */
  readKey: () => Promise<{ free: bigint; nonce: number }>;
  /** The finalized head's number on Asset Hub. */
  readFinalizedNumber?: () => Promise<number>;
  /** Runs before the broadcast, so the driver can persist the attempt about to be made. */
  onBeforeSubmit?: () => Promise<void> | void;
  onTx?: (info: { call: "pay"; txHash: string; block?: number }) => void;
}

/** The transfer: `amount` of `token` to `to`, the key kept alive with what is left. */
export function buildExactPay(api: AssetHubApi, to: string, amount: bigint, token: TokenSpec) {
  const target = { type: "Id" as const, value: to };
  if (token.assetHubId === undefined) {
    return api.tx.Balances.transfer_keep_alive({ dest: target, value: amount });
  }
  return api.tx.Assets.transfer_keep_alive({ id: token.assetHubId, target, amount });
}

/** The options a payment in `token` is signed and priced with: a stable charges the fee in
 *  itself, the native needs nothing. */
const feeOptionsOf = (token: TokenSpec): Record<string, unknown> => {
  const stable = stableOf(token);
  return stable === null ? {} : stableTxOptions(stable.symbol);
};

/**
 * The least the key must hold of `token` on Asset Hub to pay `amount` to `to`: the amount, the
 * transfer's fee with headroom, priced into a stable through its pool, and what the key keeps to
 * stay alive: the existential deposit in the native, the asset's min_balance in a stable, read
 * live. The sale is held to it before anything leaves People.
 */
export async function exactPaymentFloor(
  api: AssetHubApi,
  from: string,
  to: string,
  amount: bigint,
  token: TokenSpec,
): Promise<bigint> {
  const stable = stableOf(token);
  const feeNative = await buildExactPay(api, to, amount, token).getEstimatedFees(
    from,
    feeOptionsOf(token) as never,
  );
  const [fee, keep] = await Promise.all([
    stable === null ? feeNative : priceNativeFeeIn(api, stable.symbol, feeNative),
    stable === null ? api.constants.Balances.ExistentialDeposit() : minBalanceOf(api, stable),
  ]);
  return amount + (fee * BigInt(100 + PAY_FEE_HEADROOM_PCT)) / 100n + keep;
}

/** A stable's `min_balance` on Asset Hub, below which an account of it is reaped. */
async function minBalanceOf(
  api: AssetHubApi,
  stable: { symbol: Stable; assetHubId: number },
): Promise<bigint> {
  const details = await api.query.Assets.Asset.getValue(stable.assetHubId);
  if (details === undefined) throw new Error(`${stable.symbol} is not an asset on Asset Hub`);
  return details.min_balance;
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
 * itself would. An attempt still unlanded once the finalized chain is past its mortality can never
 * land: it is no longer in flight, and the payment is free to go again or to stand down.
 */
export async function exactPaymentLanded(
  input: Pick<ExactPayInput, "readKey" | "readFinalizedNumber" | "amount" | "tickTimeoutMs">,
  state: ExactPayState,
): Promise<boolean> {
  if (!state.inFlight) return false;
  const key = await bounded(input.readKey(), input.tickTimeoutMs, "key read");
  if (judge(key, state, input.amount) === "paid") return true;
  const anchor = state.anchor ?? null;
  if (anchor !== null && input.readFinalizedNumber !== undefined) {
    const finalized = await bounded(
      input.readFinalizedNumber(),
      input.tickTimeoutMs,
      "finalized head read",
    );
    if (finalized > anchor + PAY_MORTAL_PERIOD) {
      state.inFlight = false;
      state.balanceBefore = null;
      state.anchor = null;
    }
  }
  return false;
}

/**
 * Resolves once the payment is on chain: sent now, or sent earlier and its answer lost. Throws
 * PaymentUnresolvedError when that cannot be told, a WithdrawRejectedError once the chain refused
 * it MAX_REJECTIONS times, and anything else as transient.
 */
export async function payExactOnce(input: ExactPayInput, state: ExactPayState): Promise<void> {
  const key = await bounded(input.readKey(), input.tickTimeoutMs, "key read");
  if (judge(key, state, input.amount) === "paid") return;

  const tx = buildExactPay(input.assetHubApi, input.to, input.amount, input.token);
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
  // The newest attempt's anchor: an earlier one at this nonce lands no later than this one can.
  state.anchor = input.anchorNumber ?? state.anchor ?? null;
  await input.onBeforeSubmit?.();
  const res = await bounded(
    tx.signAndSubmit(input.key.signer, {
      ...feeOptionsOf(input.token),
      ...input.signOptions,
      nonce: state.nonce,
      mortality: { mortal: true, period: PAY_MORTAL_PERIOD },
    } as never),
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
  state.anchor = null;
  state.rejections += 1;
  const reason = describeDispatchError(res.dispatchError);
  if (state.rejections >= MAX_REJECTIONS) throw new WithdrawRejectedError("pay", reason);
  throw new Error(`payment rejected: ${reason}`);
}
