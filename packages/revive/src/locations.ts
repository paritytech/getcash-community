// XCM v5 asset locations as plain data, no papi Enum. The papi binding maps these onto
// papi's XcmVersionedLocation.

export type XcmJunction =
  { type: "PalletInstance"; value: number } | { type: "GeneralIndex"; value: bigint };

export type XcmInterior = { type: "Here" } | { type: "X2"; value: [XcmJunction, XcmJunction] };

export interface XcmLocation {
  parents: number;
  interior: XcmInterior;
}

/** Relay native (DOT) as seen from Asset Hub: one hop up. */
export function nativeAssetLocation(): XcmLocation {
  return { parents: 1, interior: { type: "Here" } };
}

/** Local pallet-asset on Asset Hub: pallet 50 (Assets) + the asset's GeneralIndex. */
export function localAssetLocation(assetId: number): XcmLocation {
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
