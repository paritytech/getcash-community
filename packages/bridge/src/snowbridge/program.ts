// The program a Snowbridge message carries for a top-up. Asset Hub runs it with the ether of the
// message in its holding. The program sends the ether to Hydration, which swaps it for USDT and
// sends the USDT to the request's account on Asset Hub. When the swap fails, Hydration sends the
// ether to that account instead.
//
// The message carries ether only. Every source reaches Ethereum as ETH for now, because getcash
// has no forwarder contract and no relayer.
// TODO: add the program for a token sent as itself (USDT, USDC) once a forwarder and a relayer
// carry it.

import { ASSET_HUB, HYDRATION, sibling } from "./chain";
import type { XcmInstruction, XcmValue } from "./codec";

/** Ethereum as the Polkadot chains name it. */
export const ETHEREUM = {
  type: "GlobalConsensus",
  value: { type: "Ethereum", value: { chain_id: 1n } },
};

/** Ether as Asset Hub and Hydration name it: the native token of Ethereum. */
export const ETHER = { parents: 2, interior: { type: "X1", value: ETHEREUM } };

/** The USDT of Asset Hub as Hydration names it. */
export const USDT_ON_HYDRATION = {
  parents: 1,
  interior: {
    type: "X3",
    value: [
      { type: "Parachain", value: ASSET_HUB },
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: 1984n },
    ],
  },
};

/** An amount of one asset. */
export const fungible = (id: unknown, amount: bigint) => ({
  id,
  fun: { type: "Fungible", value: amount },
});

/** All of one asset in the holding. */
export const allOf = (id: unknown): XcmValue => ({
  type: "Wild",
  value: { type: "AllOf", value: { id, fun: { type: "Fungible", value: undefined } } },
});

const accountOf = (account: string, network?: XcmValue) => ({
  parents: 0,
  interior: { type: "X1", value: { type: "AccountId32", value: { network, id: account } } },
});

/** `account` as the claimer of what a failure leaves in a holding. The location names the
 *  Polkadot network, because a claim looks a trap up by the signed origin of the claimant. */
export const accountClaimer = (account: string) => accountOf(account, { type: "Polkadot" });

/** Names `location` as the claimer. */
export const claimerHint = (location: unknown): XcmInstruction => ({
  type: "SetHints",
  value: { hints: [{ type: "AssetClaimer", value: { location } }] },
});

/** What Asset Hub runs when an asset comes back from Hydration: the unused fee returns to the
 *  holding, and the one asset there goes to `account`. */
const depositOnAssetHub = (account: string): XcmInstruction[] => [
  claimerHint(accountClaimer(account)),
  { type: "RefundSurplus" },
  {
    type: "DepositAsset",
    value: {
      assets: { type: "Wild", value: { type: "AllCounted", value: 1 } },
      beneficiary: accountOf(account),
    },
  },
];

/** Hydration sends all of `asset` to `account` on Asset Hub, which is the reserve of the asset.
 *  `fee` of it pays for the program there. */
export const backToAssetHub = (asset: unknown, fee: bigint, account: string): XcmInstruction => ({
  type: "InitiateTransfer",
  value: {
    destination: sibling(ASSET_HUB),
    remote_fees: {
      type: "ReserveWithdraw",
      value: { type: "Definite", value: [fungible(asset, fee)] },
    },
    preserve_origin: false,
    assets: [{ type: "ReserveWithdraw", value: allOf(asset) }],
    remote_xcm: depositOnAssetHub(account),
  },
});

export interface SnowbridgeProgramInput {
  /** The request's account on Asset Hub, as 0x and 64 hex digits. It receives the USDT, or the
   *  ether when the swap fails, and it is the claimer on both chains. */
  account: string;
  /** The ether Hydration swaps, in wei. */
  swapEther: bigint;
  /** The ether that pays for the program on Hydration, in wei. */
  hydrationFeeEther: bigint;
  /** The least USDT the swap may pay, in base units. The swap fails under it. */
  minimumUsdt: bigint;
  /** The USDT that pays for the deposit on Asset Hub, in base units. */
  assetHubFeeUsdt: bigint;
  /** The ether that pays for the deposit on Asset Hub when the swap fails, in wei. */
  assetHubFeeEther: bigint;
}

const AMOUNTS = [
  "swapEther",
  "hydrationFeeEther",
  "minimumUsdt",
  "assetHubFeeUsdt",
  "assetHubFeeEther",
] as const;

/** The program for one top-up. The message must carry `swapEther` and `hydrationFeeEther` on top
 *  of what Asset Hub charges. The ether Asset Hub does not use goes to the account. */
export function snowbridgeProgram(input: SnowbridgeProgramInput): XcmInstruction[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.account)) {
    throw new Error(`not an account of 32 bytes: ${input.account}`);
  }
  for (const name of AMOUNTS) {
    if (input[name] <= 0n) throw new Error(`${name} must be more than zero`);
  }
  const { account } = input;
  return [
    {
      type: "InitiateTransfer",
      value: {
        destination: sibling(HYDRATION),
        remote_fees: {
          type: "ReserveDeposit",
          value: { type: "Definite", value: [fungible(ETHER, input.hydrationFeeEther)] },
        },
        preserve_origin: false,
        assets: [
          {
            type: "ReserveDeposit",
            value: { type: "Definite", value: [fungible(ETHER, input.swapEther)] },
          },
        ],
        remote_xcm: [
          claimerHint(accountClaimer(account)),
          // A failed swap leaves the ether in the holding. It goes back instead of into a trap.
          {
            type: "SetErrorHandler",
            value: [backToAssetHub(ETHER, input.assetHubFeeEther, account)],
          },
          {
            type: "ExchangeAsset",
            value: {
              give: allOf(ETHER),
              want: [fungible(USDT_ON_HYDRATION, input.minimumUsdt)],
              // Give all of the ether and take all the USDT it buys.
              maximal: true,
            },
          },
          backToAssetHub(USDT_ON_HYDRATION, input.assetHubFeeUsdt, account),
        ],
      },
    },
    { type: "RefundSurplus" },
    { type: "DepositAsset", value: { assets: allOf(ETHER), beneficiary: accountOf(account) } },
  ];
}
