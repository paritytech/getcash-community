import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { callView } from "../../assethub/src/revive";
import type { Api } from "./substrate";
import { poolAbi } from "./watcher";

export type PoolExpectation = {
  settler: Address;
  token: Address;
  tokenErc20: Address;
  feeAccount: Hex;
  bridgeFee: bigint;
  frontFeeCapBps: number;
  ethereumChainId: bigint;
};

// Reads the pool's immutables from the chain and fails on any that differs from what the deployment recorded.
export async function checkPoolImmutables(api: Api, caller: Hex, pool: Address, expected: PoolExpectation): Promise<string[]> {
  const abi = poolAbi();
  const read = async (functionName: string): Promise<unknown> => {
    const data = encodeFunctionData({ abi, functionName } as never);
    return decodeFunctionResult({ abi, functionName, data: await callView(api, caller, pool, data) } as never);
  };
  const wanted: [string, unknown, (value: unknown) => string][] = [
    ["SETTLER", getAddress(expected.settler), (value) => getAddress(String(value))],
    ["TOKEN", getAddress(expected.token), (value) => getAddress(String(value))],
    ["TOKEN_ERC20", getAddress(expected.tokenErc20), (value) => getAddress(String(value))],
    ["FEE_ACCOUNT", expected.feeAccount.toLowerCase(), (value) => String(value).toLowerCase()],
    ["BRIDGE_FEE", expected.bridgeFee.toString(), (value) => String(value)],
    ["FRONT_FEE_CAP_BPS", String(expected.frontFeeCapBps), (value) => String(value)],
    ["ETHEREUM_CHAIN_ID", expected.ethereumChainId.toString(), (value) => String(value)],
  ];
  const lines: string[] = [];
  for (const [name, want, normalise] of wanted) {
    const got = normalise(await read(name));
    if (got !== String(want)) throw new Error(`the pool's ${name} is ${got} on chain, the deployment says ${String(want)}`);
    lines.push(`${name} ${got}`);
  }
  return lines;
}
