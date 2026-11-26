// The program the key's account runs on Hydration with the HOLLAR of a deposit. It swaps all of
// that HOLLAR for USDT and sends all the USDT to the request's account on Asset Hub, so no USDT
// stays on the key.

import type { XcmInstruction } from "../snowbridge/codec";
import { allOf, backToAssetHub, fungible, USDT_ON_HYDRATION } from "../snowbridge/program";

/** HOLLAR as Hydration names it: the address of its token contract there. */
export const HOLLAR = {
  parents: 0,
  interior: {
    type: "X1",
    value: {
      type: "AccountKey20",
      value: { network: undefined, key: "0x531a654d1696ed52e7275a8cede955e82620f99a" },
    },
  },
};

export interface HollarProgramInput {
  /** The request's account on Asset Hub, as 0x and 64 hex digits. It receives the USDT. */
  account: string;
  /** The HOLLAR to swap, in its base units of 18 decimals. */
  hollar: bigint;
  /** The least USDT the swap may pay, in base units. The program fails under it. */
  minimumUsdt: bigint;
  /** The USDT that pays for the deposit on Asset Hub, in base units. */
  assetHubFeeUsdt: bigint;
}

/** The program for one deposit. */
export function hollarProgram(input: HollarProgramInput): XcmInstruction[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.account)) {
    throw new Error(`not an account of 32 bytes: ${input.account}`);
  }
  for (const name of ["hollar", "minimumUsdt", "assetHubFeeUsdt"] as const) {
    if (input[name] <= 0n) throw new Error(`${name} must be more than zero`);
  }
  return [
    { type: "WithdrawAsset", value: [fungible(HOLLAR, input.hollar)] },
    {
      type: "ExchangeAsset",
      value: {
        give: allOf(HOLLAR),
        want: [fungible(USDT_ON_HYDRATION, input.minimumUsdt)],
        // Give all of the HOLLAR and take all the USDT it buys.
        maximal: true,
      },
    },
    backToAssetHub(USDT_ON_HYDRATION, input.assetHubFeeUsdt, input.account),
  ];
}
