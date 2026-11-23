// The swap of ETH for USDC on Base, through Uniswap's pool of the two. The Base vault takes USDC
// only, and a key that pays its own gas holds ETH. getcash makes this swap itself on purpose, so
// that a top-up needs no forwarder contract and no relayer.
// TODO: remove this file once a forwarder and a relayer make the deposit into the vault.

import { abiAddress, abiUint, encodeCall, wordAt } from "../evm-abi";
import type { EvmRpc } from "../evm-rpc";
import type { EvmTransactionCall } from "../evm-tx";
import { BASE_USDC } from "./chain";

/** Wrapped ETH on Base, the token the pool holds. The router wraps the ETH sent with the call. */
const BASE_WETH = "0x4200000000000000000000000000000000000006";

/** Uniswap's router and quoter on Base. */
const SWAP_ROUTER = "0x2626664c2603336e57b271c5c0b26f421741e481";
const SWAP_QUOTER = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";

/** The fee of the pool the swap takes, in hundredths of a basis point: 0.05%. */
const POOL_FEE = 500n;

/** No limit on the price the swap may reach. The minimum received is the guard. */
const NO_PRICE_LIMIT = 0n;

/** The call that swaps `ethIn` wei of ETH for USDC paid to `recipient`. It reverts when the swap
 *  would pay less than `minimumUsdcOut` base units. */
export function ethToUsdcSwap(input: {
  ethIn: bigint;
  minimumUsdcOut: bigint;
  recipient: string;
}): EvmTransactionCall {
  return {
    to: SWAP_ROUTER,
    value: input.ethIn,
    data: encodeCall("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))", [
      abiAddress(BASE_WETH),
      abiAddress(BASE_USDC),
      abiUint(POOL_FEE),
      abiAddress(input.recipient),
      abiUint(input.ethIn),
      abiUint(input.minimumUsdcOut),
      abiUint(NO_PRICE_LIMIT),
    ]),
  };
}

/** Asks the quoter with one of its two functions, which take the same fields. A simulated call:
 *  nothing is sent. The first word it returns is the amount on the other side of the swap. */
async function quote(rpc: Pick<EvmRpc, "call">, name: string, amount: bigint): Promise<bigint> {
  const returned = await rpc.call({
    to: SWAP_QUOTER,
    data: encodeCall(`${name}((address,address,uint256,uint24,uint160))`, [
      abiAddress(BASE_WETH),
      abiAddress(BASE_USDC),
      abiUint(amount),
      abiUint(POOL_FEE),
      abiUint(NO_PRICE_LIMIT),
    ]),
  });
  return wordAt(returned, 0);
}

/** The USDC base units the pool pays now for `ethIn` wei of ETH. */
export const quoteUsdcOut = (rpc: Pick<EvmRpc, "call">, ethIn: bigint): Promise<bigint> =>
  quote(rpc, "quoteExactInputSingle", ethIn);

/** The wei of ETH the pool takes now to pay `usdcOut` base units of USDC. */
export const quoteEthIn = (rpc: Pick<EvmRpc, "call">, usdcOut: bigint): Promise<bigint> =>
  quote(rpc, "quoteExactOutputSingle", usdcOut);
