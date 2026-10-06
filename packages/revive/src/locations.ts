// XCM v5 asset locations as plain data, no papi Enum; the type lives in core beside the token
// table. The papi binding maps these onto papi's XcmVersionedLocation.

import type { XcmLocation } from "@getsome/core";

export type { XcmInterior, XcmJunction, XcmLocation } from "@getsome/core";

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
