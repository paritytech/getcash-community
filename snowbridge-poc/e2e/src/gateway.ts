import type { Address, Hex } from "viem";

export type Accepted = { nonce: bigint; origin: Address; executionFee: bigint; relayerFee: bigint };

const word = (data: Hex, index: number): bigint => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);

// The Gateway's OutboundMessageAccepted(uint64 nonce, Payload payload) is its only log in a send; the payload starts with origin
// and ends with value, executionFee, relayerFee, and the head of a dynamic tuple sits at the offset in the second word.
export function acceptedIn(receipt: { logs: readonly { address: Address; data: Hex }[] }, gateway: Address): Accepted {
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === gateway.toLowerCase());
  if (!log) throw new Error("the transaction has no Gateway log");
  const head = Number(word(log.data, 1)) / 32;
  return {
    nonce: word(log.data, 0),
    origin: `0x${word(log.data, head).toString(16).padStart(40, "0")}` as Address,
    executionFee: word(log.data, head + 5),
    relayerFee: word(log.data, head + 6),
  };
}
