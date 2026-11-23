// A transfer signed by the bridge signer and sent through the bridge's Ethereum client to a local
// test node, which must take it and move the funds. The node is one started with no arguments, so
// the key below is the funded one it ships with, and nothing here touches a real chain.
// TODO: remove this file with the signer, once a forwarder and a relayer send the transactions.
//   VERIFY_BRIDGE_ANVIL=http://127.0.0.1:8545 pnpm vitest run tests/verify-bridge-signer.test.ts

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { createEvmRpc, evmAddressOf, signEvmTransaction } from "@getsome/bridge";

const NODE = process.env.VERIFY_BRIDGE_ANVIL;

/** The first key of the test mnemonic local nodes fund. */
const FUNDED_KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

describe.runIf(NODE !== undefined && NODE !== "")("the bridge signer on a local node", () => {
  it("signs a transfer that the node takes", async () => {
    const rpc = createEvmRpc(NODE!);
    const sender = evmAddressOf(FUNDED_KEY);
    // A recipient no earlier run has paid, so its balance starts from the same place each time.
    const recipient = evmAddressOf(crypto.getRandomValues(new Uint8Array(32)));
    const value = 1_000_000_000_000_000n;

    const [chainId, nonce, baseFee, tip, before] = await Promise.all([
      rpc.chainId(),
      rpc.nonce(sender),
      rpc.baseFee(),
      rpc.priorityFee(),
      rpc.balance(recipient),
    ]);
    const signed = signEvmTransaction(
      {
        chainId,
        nonce,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: 2n * baseFee + tip,
        gasLimit: 21_000n,
        to: recipient,
        value,
        data: new Uint8Array(0),
      },
      FUNDED_KEY,
    );

    const hash = await rpc.send(signed.raw);
    expect(hash).toBe(`0x${bytesToHex(signed.hash)}`);

    let receipt = await rpc.receipt(hash);
    for (let waited = 0; receipt === null && waited < 20; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      receipt = await rpc.receipt(hash);
    }
    expect(receipt).toMatchObject({ succeeded: true, gasUsed: 21_000n });
    expect(await rpc.balance(recipient)).toBe(before + value);
    expect(await rpc.nonce(sender)).toBe(nonce + 1n);
  });
});
