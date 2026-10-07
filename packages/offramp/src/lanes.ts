// The offramp lanes: each (chain, asset) a fiat sale can be sold through when Meld has no provider
// for the Asset Hub asset itself. The key sells Asset Hub USDT through Chainflip for the lane's
// asset, paid straight to the Meld provider's deposit address. Adding a lane is one entry here.

export type LaneId = "usdt-solana" | "usdc-solana";

export interface OfframpLane {
  readonly id: LaneId;
  /** What Chainflip delivers to the provider, as the SDK names it. */
  readonly chainflip: { readonly chain: string; readonly asset: string };
  /** The asset's code in the Meld adapter's sell catalog. Unconfirmed until the catalog lists it:
   *  a wrong code only means no provider quotes the lane. */
  readonly meldCode: string;
  /** Base-unit decimals on the lane's chain. Never assumed: BSC USDT is 18. */
  readonly decimals: number;
}

export const LANES: readonly OfframpLane[] = Object.freeze([
  {
    id: "usdt-solana",
    chainflip: { chain: "Solana", asset: "USDT" },
    meldCode: "USDT_SOL",
    decimals: 6,
  },
  {
    id: "usdc-solana",
    chainflip: { chain: "Solana", asset: "USDC" },
    meldCode: "USDC_SOL",
    decimals: 6,
  },
] satisfies OfframpLane[]);

export const isLaneId = (value: unknown): value is LaneId => LANES.some((l) => l.id === value);

export function laneById(id: LaneId): OfframpLane {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new Error(`Unknown offramp lane ${id}`);
  return lane;
}

/** The lane's asset as a Meld sale names and sizes it. */
export const laneSellToken = (lane: OfframpLane) => ({
  symbol: lane.chainflip.asset,
  decimals: lane.decimals,
  meldCurrencyCode: lane.meldCode,
});
