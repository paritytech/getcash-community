// What the buyer sends for this purchase, priced by Chainflip, as the pay card reads it.

export interface SourcePrice {
  /** Ready to render, e.g. "0.00042", in the source asset's own units. */
  formatted: string;
  /** The same figure in the asset's base units. */
  baseUnits: bigint;
}

/** This purchase is under Chainflip's floor for the asset. */
export interface SourceMinimum {
  /** The floor, in the source asset's units, ready to render. */
  minimumFormatted: string;
  assetSymbol: string;
  /** The floor and what this purchase needed, in the asset's base units. */
  minimumBaseUnits: bigint;
  neededBaseUnits: bigint;
  /** `neededBaseUnits` ready to render. */
  neededFormatted: string;
}

export type SourcePriceResult =
  /** Set by the caller while a price is being asked for. */
  | { kind: "pending" }
  | { kind: "price"; price: SourcePrice }
  | { kind: "minimum"; minimum: SourceMinimum }
  | { kind: "unavailable"; reason: string };
