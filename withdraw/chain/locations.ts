import {
  XcmV3MultiassetFungibility,
  XcmV3WeightLimit,
  XcmV5AssetFilter,
  XcmV5Instruction,
  XcmV5Junction,
  XcmV5Junctions,
  XcmV5WildAsset,
  XcmVersionedXcm,
} from "@polkadot-api/descriptors";
import { PASEO_ASSET_HUB_PARA_ID, PUSD_ASSET_ID } from "./constants";
import type { Hex32 } from "./account";

export const NATIVE_LOCATION = {
  parents: 1,
  interior: XcmV5Junctions.Here(),
};

export const PUSD_LOCATION = {
  parents: 1,
  interior: XcmV5Junctions.X3([
    XcmV5Junction.Parachain(PASEO_ASSET_HUB_PARA_ID),
    XcmV5Junction.PalletInstance(50),
    XcmV5Junction.GeneralIndex(BigInt(PUSD_ASSET_ID)),
  ]),
};

export function createDrainXcmArgs(args: {
  pUsdAmount: bigint;
  pasAmount: bigint;
  pasForRemoteExecution: bigint;
  beneficiaryHex: Hex32;
}) {
  const destination = {
    parents: 1,
    interior: XcmV5Junctions.X1(XcmV5Junction.Parachain(PASEO_ASSET_HUB_PARA_ID)),
  };
  const beneficiary = {
    parents: 0,
    interior: XcmV5Junctions.X1(
      XcmV5Junction.AccountId32({ network: undefined, id: args.beneficiaryHex }),
    ),
  };
  const allTwoAssets = XcmV5AssetFilter.Wild(XcmV5WildAsset.AllCounted(2));

  return {
    message: XcmVersionedXcm.V5([
      XcmV5Instruction.WithdrawAsset([
        { id: NATIVE_LOCATION, fun: XcmV3MultiassetFungibility.Fungible(args.pasAmount) },
        { id: PUSD_LOCATION, fun: XcmV3MultiassetFungibility.Fungible(args.pUsdAmount) },
      ]),
      XcmV5Instruction.InitiateTeleport({
        assets: allTwoAssets,
        dest: destination,
        xcm: [
          XcmV5Instruction.BuyExecution({
            fees: {
              id: NATIVE_LOCATION,
              fun: XcmV3MultiassetFungibility.Fungible(args.pasForRemoteExecution),
            },
            weight_limit: XcmV3WeightLimit.Unlimited(),
          }),
          XcmV5Instruction.DepositAsset({
            assets: allTwoAssets,
            beneficiary,
          }),
        ],
      }),
    ]),
  };
}
