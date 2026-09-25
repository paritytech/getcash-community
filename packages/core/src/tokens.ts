// The token table: what each asset is called, its decimals, how each chain keys it and what the
// rails call it, in one place. Every asset constant the other packages export derives from here,
// so the wire code and the arithmetic cannot disagree about which asset is in flight.
//
// Paseo Next only. A second network is a second table, not a second mechanism.

// XCM v5 asset locations as plain data, no papi Enum. Papi's Enum values are plain `{type, value}`
// objects, so a precisely typed literal in this shape is accepted wherever the descriptors expect
// a Location.

export type XcmJunction =
  | { type: "Parachain"; value: number }
  | { type: "PalletInstance"; value: number }
  | { type: "GeneralIndex"; value: bigint };

export type XcmInterior =
  | { type: "Here" }
  | { type: "X2"; value: [XcmJunction, XcmJunction] }
  | { type: "X3"; value: [XcmJunction, XcmJunction, XcmJunction] };

export interface XcmLocation {
  parents: number;
  interior: XcmInterior;
}

export interface TokenSpec {
  /** Display and log symbol. */
  symbol: string;
  decimals: number;
  /** As Asset Hub keys it. */
  location: XcmLocation;
  /** As the People chain keys it, when it exists there. */
  locationOnPeople?: XcmLocation;
  /** pallet-assets u32 id on Asset Hub, for the calls that still take one. */
  assetHubId?: number;
  /** Chainflip egress asset name, when the rail can deliver it. */
  chainflipAsset?: string;
  /** Meld destinationCurrencyCode, when Meld can deliver it. */
  meldCurrencyCode?: string;
}

export type TokenTable = Readonly<Record<"PAS" | "CASH" | "USDT" | "USDC", TokenSpec>>;

/** The relay native as any parachain keys it: one hop up. */
const RELAY_NATIVE: XcmLocation = { parents: 1, interior: { type: "Here" } };

/** A pallet-assets asset as Asset Hub keys it: local, so parents 0; pallet 50 is Assets. */
function assetHubLocal(assetId: number): XcmLocation {
  return {
    parents: 0,
    interior: {
      type: "X2",
      value: [
        { type: "PalletInstance", value: 50 },
        { type: "GeneralIndex", value: BigInt(assetId) },
      ],
    },
  };
}

// `satisfies` rather than a `TokenTable` annotation: each entry keeps its literal shape, so the
// constants derived from it keep types the descriptors accept without a cast.
export const TOKENS = {
  PAS: {
    symbol: "PAS",
    decimals: 10,
    location: RELAY_NATIVE,
    locationOnPeople: RELAY_NATIVE,
    // Both rails name Paseo's native after its Polkadot counterpart.
    chainflipAsset: "DOT",
    meldCurrencyCode: "DOT_ASSETHUB",
  },
  CASH: {
    symbol: "CASH",
    decimals: 6,
    assetHubId: 50_000_413,
    location: assetHubLocal(50_000_413),
    // Held on People as a foreign asset keyed by its Asset Hub Next (para 1500) reserve Location.
    locationOnPeople: {
      parents: 1,
      interior: {
        type: "X3",
        value: [
          { type: "Parachain", value: 1500 },
          { type: "PalletInstance", value: 50 },
          { type: "GeneralIndex", value: 50_000_413n },
        ],
      },
    },
  },
  USDT: {
    symbol: "USDT",
    decimals: 6,
    assetHubId: 1984,
    location: assetHubLocal(1984),
    chainflipAsset: "USDT",
    meldCurrencyCode: "USDT_ASSETHUB",
  },
  USDC: {
    symbol: "USDC",
    decimals: 6,
    assetHubId: 1337,
    location: assetHubLocal(1337),
  },
} satisfies TokenTable;
