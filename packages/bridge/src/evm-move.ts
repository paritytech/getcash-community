// An Ethereum transaction as a move of the bridge leg. The key of the request signs it from live
// reads. The same signed bytes are sent however often, and the transaction is found again by
// its hash.
// TODO: remove this file once a forwarder and a relayer send the transactions.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { EvmRpc } from "./evm-rpc";
import { evmAddressOf, signEvmTransaction, type EvmTransactionCall } from "./evm-tx";
import type { BridgeMove } from "./leg";

export interface EvmMoveInput {
  rpc: EvmRpc;
  chainId: bigint;
  privateKey: Uint8Array;
  /** The call to sign, from live reads. It throws `BridgeMoveRefused` when the call must not be
   *  made. */
  build(): Promise<EvmTransactionCall>;
}

/** The move that signs and sends the call `input.build` gives. */
export function evmMove(input: EvmMoveInput): BridgeMove {
  const { rpc, chainId, privateKey } = input;
  const bytesOf = (prepared: string): Uint8Array => hexToBytes(prepared.slice(2));
  return {
    async prepare() {
      const call = await input.build();
      const from = evmAddressOf(privateKey);
      const [nonce, baseFee, tip, gas] = await Promise.all([
        rpc.nonce(from),
        rpc.baseFee(),
        rpc.priorityFee(),
        rpc.estimateGas({ ...call, from }),
      ]);
      const signed = signEvmTransaction(
        {
          chainId,
          nonce,
          maxPriorityFeePerGas: tip,
          // The base fee can rise before the transaction is in a block.
          maxFeePerGas: 2n * baseFee + tip,
          gasLimit: gas + gas / 5n,
          ...call,
        },
        privateKey,
      );
      return `0x${bytesToHex(signed.raw)}`;
    },

    async send(prepared) {
      await rpc.send(bytesOf(prepared));
    },

    async landed(prepared) {
      const receipt = await rpc.receipt(`0x${bytesToHex(keccak_256(bytesOf(prepared)))}`);
      if (receipt === null) return "not-yet";
      return receipt.succeeded ? "yes" : "failed";
    },
  };
}
