// The fee Base adds to a transaction for its data, on top of the gas. Only an account that sends
// its own transactions pays it, and getcash does that on purpose, so that a top-up needs no
// forwarder contract and no relayer.
// TODO: remove this file once a forwarder and a relayer send the transactions.

import { abiBytes, encodeCall, wordAt } from "../evm-abi";
import type { EvmRpc } from "../evm-rpc";

/** The contract of Base that prices the data of a transaction. */
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000f";

/** The most Base charges now for the data of the signed transaction `raw`, in wei. The oracle adds
 *  room for a signature to the bytes it gets, so for bytes that already hold one the answer is the
 *  charge or a little more. */
export async function baseDataFee(rpc: Pick<EvmRpc, "call">, raw: Uint8Array): Promise<bigint> {
  const returned = await rpc.call({
    to: GAS_PRICE_ORACLE,
    data: encodeCall("getL1Fee(bytes)", [abiBytes(raw)]),
  });
  return wordAt(returned, 0);
}
