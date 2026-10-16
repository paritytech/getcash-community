// The sale as the withdrawal's rail leg reads it: the adapter's funding record for a sell, as the
// provider's channel before the key pays and as its status after. The worker asks both through
// the same `GET /funding/:id` the page polls during KYC.

import {
  meldAssetOf,
  meldCodeOf,
  NETWORK,
  TOKENS,
  type MeldAssetId,
  type SwapStatusResult,
} from "@getsome/core";
import type { MeldClientLike, MeldQuoteEntry, MeldStatusResult } from "./client";
import { formatBaseUnits, parseBaseUnits, type MeldToken } from "./units";

/** Whether this build sells CASH for fiat through Meld, the card and bank withdrawals. On a test
 *  network the sale only ever moves test funds. On a live one it stays off until a small real sale
 *  has been watched end to end: Meld settles a sell only in production, so the sandbox never
 *  proves the payout. The page offers card and bank by it and the worker refuses a sale without
 *  it, so neither trusts the other to hold the line. */
export const MELD_SELL_ENABLED = NETWORK.testnet;

/** What a sale sells unless its code names another asset: the native on Asset Hub. */
export const SELL_TOKEN: MeldToken = TOKENS.PAS as MeldToken;

/** USDT on Asset Hub as a direct sale sells it: the PSM redeems the CASH for it, and the key pays
 *  the provider in it. `meldCurrencyCode` is read from the adapter's asset table when used, so a
 *  Meld rename reaches every sale without a release. */
export const USDT_SELL_TOKEN: MeldToken = {
  symbol: TOKENS.USDT.symbol,
  decimals: TOKENS.USDT.decimals,
  get meldCurrencyCode(): string {
    return meldCodeOf("usdt@assethub");
  },
};

/** What a direct sale sells, on Asset Hub with no swap, by the app's name for the asset. */
const DIRECT_SELL_TOKENS: ReadonlyMap<MeldAssetId, MeldToken> = new Map<MeldAssetId, MeldToken>([
  ["usdt@assethub", USDT_SELL_TOKEN],
  ["dot@assethub", SELL_TOKEN],
]);

/** Whether a direct sale under `code` sells USDT. */
export const isDirectUsdt = (code: string | undefined): boolean =>
  meldAssetOf(code) === "usdt@assethub";

/** Whether `code` is one a direct sale can sell: Meld's current code for USDT or DOT on Asset Hub. */
export const isDirectSellCode = (code: string | undefined): boolean => {
  const asset = meldAssetOf(code);
  return asset !== undefined && DIRECT_SELL_TOKENS.has(asset);
};

/** The Meld codes a direct sale can sell, as the adapter names them now. */
export const directSellCodes = (): string[] =>
  [...DIRECT_SELL_TOKENS.values()].map((token) => token.meldCurrencyCode);

/** What a direct sale of `asset` sells, or undefined for an asset no direct sale sells. Read by
 *  the app's name for the asset, so a sale opened under a code Meld has since renamed still reads
 *  as what it sold. */
export const directSellTokenOf = (asset: MeldAssetId): MeldToken | undefined =>
  DIRECT_SELL_TOKENS.get(asset);

/** The direct sale's asset under `code`, one `isDirectSellCode` accepts. */
export function directSellToken(code: string): MeldToken {
  const asset = meldAssetOf(code);
  const token = asset === undefined ? undefined : DIRECT_SELL_TOKENS.get(asset);
  if (token === undefined) throw new Error(`A sale cannot sell ${code} directly.`);
  return token;
}

/** Whether a deposit's asset code names what the sale sells: the same code, or another code the
 *  adapter's table gives the same asset. */
export const sameSoldAsset = (depositCode: string, soldCode: string): boolean => {
  if (depositCode === soldCode) return true;
  const asset = meldAssetOf(depositCode);
  return asset !== undefined && asset === meldAssetOf(soldCode);
};

/** The fraction digits a committed amount carries. Few enough that no provider rounds it, and the
 *  base units below them stay with the rest of the sale. */
const SELL_AMOUNT_DECIMALS = 4;

/** `base` units of `token` cut down to what a sale may commit, rounded down. */
export function sellAmountOf(base: bigint, token: Pick<MeldToken, "decimals">): bigint {
  const step = 10n ** BigInt(Math.max(token.decimals - SELL_AMOUNT_DECIMALS, 0));
  return (base / step) * step;
}

/** The committed amount as the adapter and the provider see it. */
export const formatSellAmount = (base: bigint, token: Pick<MeldToken, "decimals">): string =>
  formatBaseUnits(token, base);

/**
 * Providers Meld lists as running only the standard sell flow: their widget finishes the trade
 * itself and asks the seller to send to its own address, where a sale here is paid for the seller
 * once the address is read off the transaction. Matched on the name, case and punctuation dropped.
 */
const STANDARD_FLOW_ONLY = ["COINBASE", "KOYWE", "PAYBIS", "ROBINHOOD"];

/** Whether a quote line can carry a sale: a provider that runs Meld's preferred sell flow, and a
 *  payout that is a positive number. */
export function sellQuoteUsable(line: MeldQuoteEntry): boolean {
  const name = line.serviceProvider.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (STANDARD_FLOW_ONLY.some((prefix) => name.startsWith(prefix))) return false;
  const payout = Number(line.destinationAmount);
  return Number.isFinite(payout) && payout > 0;
}

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
 * adapter is not disclosing a deposit, or discloses one the key must not pay: an asset none of
 * `tokens` names, or an amount that does not parse.
 */
export function saleChannelOf(
  result: MeldStatusResult,
  tokens: MeldToken | readonly MeldToken[],
): SaleChannelRecord | null {
  const { deposit } = result;
  if (deposit === undefined) return null;
  const token = (Array.isArray(tokens) ? tokens : [tokens as MeldToken]).find((t) =>
    sameSoldAsset(deposit.currency, t.meldCurrencyCode),
  );
  if (token === undefined) return null;
  const expectedAmount = parseBaseUnits(token, deposit.amount);
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
  refunded: "The provider returned the funds instead of paying out. Contact support.",
  unobserved:
    "We could not confirm the payout with the provider. Contact support with your reference.",
  changed: "The provider changed the sale after your payment. Contact support with your reference.",
});

/** The sale's status as the rail leg follows it once the key has paid. A deposit the provider
 *  changed after showing it ends the follow: the key paid what was shown, so the sale is no longer
 *  the one the provider expects, whatever its status says. */
export function saleStatusView(result: MeldStatusResult): SwapStatusResult {
  const { status, providerStatus } = result;
  if (result.depositConflictAt !== undefined && status !== "settled") {
    return {
      status: "failed",
      depositFailure: { reason: { code: "changed", message: ENDINGS.changed! }, kind: "unknown" },
      raw: status,
    };
  }
  if (status === "settled") return { status: "complete", raw: status };
  // A REFUNDED provider ending rides on the adapter's coarse `failed`.
  const refunded = providerStatus?.trim().toUpperCase() === "REFUNDED";
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

/** Consecutive not-found answers after which the adapter is taken to have lost a sale, as the
 *  page takes it after the same count, and only once they have lasted SALE_GONE_FOR_MS. */
export const SALE_GONE_AFTER = 3;
/** How long the adapter must keep answering not-found before a sale is taken as lost: longer than
 *  a restart or a deploy of the adapter takes. */
export const SALE_GONE_FOR_MS = 120_000;

/** Where the rail keeps its count of the adapter's consecutive not-found answers, and since when:
 *  the worker's job, persisted between ticks. */
export interface SaleReadMemory {
  saleNotFound?: number;
  saleNotFoundSince?: number;
}

/**
 * The rail leg's two reads of a sale through `client`: its channel before the key pays, its status
 * after. A sale the adapter keeps answering 404 for (a reset database, a product id that changed)
 * is gone after SALE_GONE_AFTER reads in a row spanning SALE_GONE_FOR_MS: no channel to pay, so the
 * key goes home, or, once paid, a payout nobody can confirm. Short of that, and on any other
 * failure, the read throws and the next tick reads again. `tokens` is what the sale may sell, which
 * the deposit is read in.
 */
export function saleRail(
  client: MeldClientLike,
  memory: SaleReadMemory,
  now: () => number,
  tokens: MeldToken | readonly MeldToken[],
) {
  const read = async (fundingRequestId: string): Promise<MeldStatusResult | null> => {
    try {
      const result = await client.getStatus(fundingRequestId);
      delete memory.saleNotFound;
      delete memory.saleNotFoundSince;
      return result;
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status !== 404) throw error;
      memory.saleNotFound = (memory.saleNotFound ?? 0) + 1;
      memory.saleNotFoundSince ??= now();
      const gone =
        memory.saleNotFound >= SALE_GONE_AFTER &&
        now() - memory.saleNotFoundSince >= SALE_GONE_FOR_MS;
      if (!gone) throw error;
      return null;
    }
  };
  return {
    channel: async (fundingRequestId: string): Promise<SaleChannelRecord | null> => {
      const result = await read(fundingRequestId);
      return result === null ? null : saleChannelOf(result, tokens);
    },
    status: async (fundingRequestId: string): Promise<SwapStatusResult> =>
      saleStatusView((await read(fundingRequestId)) ?? { status: "unobserved" }),
  };
}
