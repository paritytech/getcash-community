// The sale as the withdrawal's rail leg reads it: the adapter's funding record for a sell, as the
// provider's channel before the key pays and as its status after. The worker asks both through
// the same `GET /funding/:id` the page polls during KYC.

import { TOKENS, type SwapStatusResult } from "@getsome/core";
import type { MeldClientLike, MeldStatusResult } from "./client";
import { formatBaseUnits, parseBaseUnits } from "./units";

/** What a sale sells: the native on Asset Hub, which Meld names DOT_ASSETHUB. */
export const SELL_TOKEN = TOKENS.PAS;

/** The fraction digits a committed amount carries. Few enough that no provider rounds it, and the
 *  planck below them stay with the rest of the sale. */
const SELL_AMOUNT_DECIMALS = 4;

/** `planck` cut down to what a sale may commit, rounded down. */
export function sellAmountOf(planck: bigint): bigint {
  const step = 10n ** BigInt(SELL_TOKEN.decimals - SELL_AMOUNT_DECIMALS);
  return (planck / step) * step;
}

/** The committed amount as the adapter and the provider see it. */
export const formatSellAmount = (planck: bigint): string => formatBaseUnits(SELL_TOKEN, planck);

/** Adapter states in which the sale can still take the crypto. */
const LIVE = new Set(["created", "session_opened", "transaction_seen"]);

const saleLive = (status: string): boolean => LIVE.has(status);

/** The provider's record of a sale, in the shape the rail leg checks before the key pays. */
export interface SaleChannelRecord {
  depositAddress: string;
  /** The sale pays out in fiat; there is no address to compare. */
  payout: "off-chain";
  expired: boolean;
  /** What the provider expects, in the token's base units. */
  expectedAmount: bigint;
}

/**
 * The sale as a channel: where the key pays and how much the provider expects. Null when the
 * adapter is not disclosing a deposit, or discloses one the key must not pay: another asset, or
 * an amount that does not parse.
 */
export function saleChannelOf(result: MeldStatusResult): SaleChannelRecord | null {
  const { deposit } = result;
  if (deposit === undefined || deposit.currency !== SELL_TOKEN.meldCurrencyCode) return null;
  const expectedAmount = parseBaseUnits(SELL_TOKEN, deposit.amount);
  if (expectedAmount === null || expectedAmount <= 0n) return null;
  return {
    depositAddress: deposit.address,
    payout: "off-chain",
    expired: !saleLive(result.status),
    expectedAmount,
  };
}

/** Endings after the key paid, each in the seller's words. The payout is the provider's now. */
const ENDINGS: Readonly<Record<string, string>> = Object.freeze({
  failed: "The provider could not complete the payout. Contact support with your reference.",
  expired:
    "The sale closed at the provider before it saw the funds. Contact support with your reference.",
  refused: "The provider did not accept this sale. Contact support with your reference.",
  declined: "The provider did not accept this sale. Contact support with your reference.",
  refunded: "The provider returned the funds instead of paying out. Contact support.",
  unobserved:
    "We could not confirm the payout with the provider. Contact support with your reference.",
});

/** The sale's status as the rail leg follows it once the key has paid. */
export function saleStatusView(result: MeldStatusResult): SwapStatusResult {
  const { status, providerStatus } = result;
  if (status === "settled") return { status: "complete", raw: status };
  // A REFUNDED provider ending rides on the adapter's coarse `failed`.
  const refunded = status === "refunded" || providerStatus?.trim().toUpperCase() === "REFUNDED";
  const message = refunded ? ENDINGS.refunded : ENDINGS[status];
  if (message !== undefined) {
    return {
      status: "failed",
      depositFailure: {
        reason: { code: refunded ? "refunded" : status, message },
        kind: "unknown",
      },
      raw: providerStatus ?? status,
    };
  }
  // `transaction_seen` and anything the adapter adds later: the provider is working on it.
  return { status: "receiving", raw: status };
}

/** One read of a sale, as its channel. */
export async function readSaleChannel(
  client: MeldClientLike,
  fundingRequestId: string,
): Promise<SaleChannelRecord | null> {
  return saleChannelOf(await client.getStatus(fundingRequestId));
}

/** One read of a sale, as its status. */
export async function readSaleStatus(
  client: MeldClientLike,
  fundingRequestId: string,
): Promise<SwapStatusResult> {
  return saleStatusView(await client.getStatus(fundingRequestId));
}
