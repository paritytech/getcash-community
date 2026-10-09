// The offramp lanes: each (chain, asset) a fiat sale can be sold through when Meld has no provider
// for the Asset Hub asset itself. The key sells Asset Hub USDT through Chainflip for the lane's
// asset, paid straight to the Meld provider's deposit address. Adding a lane is one entry here.

export type LaneId = "usdc-arbitrum" | "usdc-solana" | "usdt-solana";

export interface OfframpLane {
  readonly id: LaneId;
  /** What Chainflip delivers to the provider, as the SDK names it. */
  readonly chainflip: { readonly chain: string; readonly asset: string };
  /** The asset's code in Meld's `CRYPTO_OFFRAMP` catalog, which the adapter passes through. */
  readonly meldCode: string;
  /** Base-unit decimals on the lane's chain. Never assumed: BSC USDT is 18. */
  readonly decimals: number;
  /** Chainflip's fill-or-kill tolerance on the swap, basis points. */
  readonly slippageBps: number;
  /** How many times the quoted delivery fee the sale keeps in hand, for gas rising between the
   *  quote and the delivery: 1 trusts the quote, 3 survives the fee tripling. */
  readonly egressFeeHeadroom: number;
}

export const LANES: readonly OfframpLane[] = Object.freeze([
  {
    id: "usdc-arbitrum",
    chainflip: { chain: "Arbitrum", asset: "USDC" },
    meldCode: "USDC_ARBITRUM",
    decimals: 6,
    slippageBps: 50,
    // Fractions of a cent today; spikes are short but sharp.
    egressFeeHeadroom: 3,
  },
  {
    id: "usdt-solana",
    chainflip: { chain: "Solana", asset: "USDT" },
    meldCode: "USDT_SOLANA",
    decimals: 6,
    slippageBps: 50,
    egressFeeHeadroom: 2,
  },
  {
    id: "usdc-solana",
    chainflip: { chain: "Solana", asset: "USDC" },
    meldCode: "USDC_SOLANA",
    decimals: 6,
    slippageBps: 50,
    // About 0.32 USDC and steady.
    egressFeeHeadroom: 2,
  },
] satisfies OfframpLane[]);

export const isLaneId = (value: unknown): value is LaneId => LANES.some((l) => l.id === value);

export function laneById(id: LaneId): OfframpLane {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new Error(`Unknown offramp lane ${id}`);
  return lane;
}

/** The lane a Meld code sells through, as the adapter's off-ramp catalog names it; null for a code
 *  this build has no swap for. */
export const laneByMeldCode = (code: string): OfframpLane | null =>
  LANES.find((l) => l.meldCode === code) ?? null;

/** The lane's asset as a Meld sale names and sizes it. */
export const laneSellToken = (lane: OfframpLane) => ({
  symbol: lane.chainflip.asset,
  decimals: lane.decimals,
  meldCurrencyCode: lane.meldCode,
});
