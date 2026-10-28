// The offramp lanes: each (chain, asset) a fiat sale can be sold through when Meld has no provider
// for the Asset Hub asset itself. The key sells Asset Hub USDT through Chainflip for the lane's
// asset, paid from the sale's own SaleVaultProxy. Solana lanes are not sold. Adding a lane is one entry.
// Meld's code for each lane's asset is the adapter's, read at use (see `@getsome/core`'s
// `meld-assets`); a lane names only the asset.

import { meldAssetOf, meldCodeOf, type MeldAssetId } from "@getsome/core";

export type LaneId = "usdc-arbitrum" | "usdc-solana" | "usdt-solana";

export interface OfframpLane {
  readonly id: LaneId;
  /** What Chainflip delivers to the provider, as the SDK names it. */
  readonly chainflip: { readonly chain: string; readonly asset: string };
  /** The app's name for the asset Meld buys on this lane. */
  readonly asset: MeldAssetId;
  /** Base-unit decimals on the lane's chain. */
  readonly decimals: number;
  /** Chainflip's fill-or-kill tolerance on the swap, basis points. */
  readonly slippageBps: number;
  /** How many times the quoted delivery fee the sale keeps in hand, for gas rising between the
   *  quote and the delivery: 1 trusts the quote, 3 survives the fee tripling. Arbitrum's spikes
   *  are sharper than Solana's. */
  readonly egressFeeHeadroom: number;
  /** Who sends the provider its crypto: the sale's own SaleVaultProxy, or nothing this app controls. */
  readonly refundSender: "sale-vault-proxy" | "none";
}

// Every lane a record may name, sold or not
const CATALOG: readonly OfframpLane[] = Object.freeze([
  {
    id: "usdc-arbitrum",
    chainflip: { chain: "Arbitrum", asset: "USDC" },
    asset: "usdc@arbitrum",
    decimals: 6,
    slippageBps: 50,
    egressFeeHeadroom: 3,
    refundSender: "sale-vault-proxy",
  },
  {
    id: "usdt-solana",
    chainflip: { chain: "Solana", asset: "USDT" },
    asset: "usdt@solana",
    decimals: 6,
    slippageBps: 50,
    egressFeeHeadroom: 2,
    refundSender: "none",
  },
  {
    id: "usdc-solana",
    chainflip: { chain: "Solana", asset: "USDC" },
    asset: "usdc@solana",
    decimals: 6,
    slippageBps: 50,
    egressFeeHeadroom: 2,
    refundSender: "none",
  },
] satisfies OfframpLane[]);

/** Whether a sale can go through the lane: only with a sender a provider refund can return to. */
export const laneSellable = (lane: OfframpLane): boolean => lane.refundSender !== "none";

/** The lanes a sale can go through, the one list every consumer reads. */
export const LANES: readonly OfframpLane[] = Object.freeze(CATALOG.filter(laneSellable));

/** The assets of the lanes never sold through, so a build naming one is warned. */
export const UNSOLD_LANE_ASSETS: readonly MeldAssetId[] = Object.freeze(
  CATALOG.filter((l) => !laneSellable(l)).map((l) => l.asset),
);

/** Whether a value names a lane a record may hold, sold or not. */
export const isLaneId = (value: unknown): value is LaneId => CATALOG.some((l) => l.id === value);

/** The lane a record names, sold or not, so a kept sale still reads its asset. */
export function laneById(id: LaneId): OfframpLane {
  const lane = CATALOG.find((l) => l.id === id);
  if (!lane) throw new Error(`Unknown offramp lane ${id}`);
  return lane;
}

/** The lane a Meld code sells through, as the adapter's off-ramp catalog names it; null for a code
 *  this build has no sellable swap for. */
export const laneByMeldCode = (code: string): OfframpLane | null => {
  const asset = meldAssetOf(code);
  return asset === undefined ? null : (LANES.find((l) => l.asset === asset) ?? null);
};

/** The lane's asset as a Meld sale names and sizes it, under the code the adapter gives it now. */
export const laneSellToken = (lane: OfframpLane) => ({
  symbol: lane.chainflip.asset,
  decimals: lane.decimals,
  get meldCurrencyCode(): string {
    return meldCodeOf(lane.asset);
  },
});
