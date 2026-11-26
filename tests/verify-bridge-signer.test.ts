// A transfer signed by the bridge signer and sent through the bridge's Ethereum client to a local
// test node, which must take it and move the funds. Then the same transfer as the transaction of
// a bridge leg, which must pay once, also after a send that the caller did not save. The node is
// one started with no arguments, so the key below is the funded one it ships with, and nothing
// here touches a real chain.
// TODO: remove this file with the signer, once a forwarder and a relayer send the transactions.
//   VERIFY_BRIDGE_ANVIL=http://127.0.0.1:8545 pnpm vitest run tests/verify-bridge-signer.test.ts

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  BridgeLegEnded,
  type BridgeLegState,
  bridgeTickOnce,
  createEvmRpc,
  evmAddressOf,
  evmMove,
  EvmRpcError,
  freshBridgeLegState,
  signEvmTransaction,
  type SnowbridgeLegHands,
} from "@getsome/bridge";

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

  /** A leg whose one transaction is a transfer of `value` to `recipient`. */
  async function transferLeg(recipient: string, value: bigint) {
    const rpc = createEvmRpc(NODE!);
    const move = evmMove({
      rpc,
      chainId: await rpc.chainId(),
      privateKey: FUNDED_KEY,
      build: async () => ({ to: recipient, value, data: new Uint8Array(0) }),
    });
    const hands: SnowbridgeLegHands = {
      route: "snowbridge",
      funding: async () => "ready",
      gateway: move,
      arrival: async () => ((await rpc.balance(recipient)) > 0n ? "usdt" : "nothing"),
    };
    return { rpc, move, hands };
  }

  /** Runs the leg to its end as a caller does: the state goes through JSON before each run, and
   *  a run that throws is run again. It returns the bytes the leg signed. */
  async function runToEnd(hands: SnowbridgeLegHands, start: BridgeLegState): Promise<string[]> {
    let state = start;
    const signed = new Set<string>();
    for (let runs = 0; runs < 40 && state.step !== "done"; runs++) {
      state = JSON.parse(JSON.stringify(state));
      try {
        await bridgeTickOnce(hands, state);
      } catch (error) {
        if (error instanceof BridgeLegEnded) throw error;
      }
      if (state.prepared !== null) {
        signed.add(state.prepared);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(state.step).toBe("done");
    return [...signed];
  }

  it("runs a transfer as the transaction of a bridge leg, and the node takes it once", async () => {
    const recipient = evmAddressOf(crypto.getRandomValues(new Uint8Array(32)));
    const value = 2_000_000_000_000_000n;
    const { rpc, move, hands } = await transferLeg(recipient, value);
    const sender = evmAddressOf(FUNDED_KEY);
    const nonce = await rpc.nonce(sender);

    const signed = await runToEnd(hands, freshBridgeLegState("snowbridge"));
    expect(signed).toHaveLength(1);
    expect(await rpc.balance(recipient)).toBe(value);
    expect(await rpc.nonce(sender)).toBe(nonce + 1n);

    // The node refuses the same bytes a second time, and nothing more moves.
    await expect(move.send(signed[0]!)).rejects.toBeInstanceOf(EvmRpcError);
    expect(await rpc.balance(recipient)).toBe(value);
    expect(await rpc.nonce(sender)).toBe(nonce + 1n);
  });

  it("does not pay twice when a run sent the transaction and the caller did not save that", async () => {
    const recipient = evmAddressOf(crypto.getRandomValues(new Uint8Array(32)));
    const value = 3_000_000_000_000_000n;
    const { rpc, move, hands } = await transferLeg(recipient, value);
    const sender = evmAddressOf(FUNDED_KEY);
    const nonce = await rpc.nonce(sender);
    const prepared = await move.prepare();
    await move.send(prepared);

    const state: BridgeLegState = {
      ...freshBridgeLegState("snowbridge"),
      step: "gateway",
      prepared,
    };
    const signed = await runToEnd(hands, state);
    expect(signed).toEqual([prepared]);
    expect(await rpc.balance(recipient)).toBe(value);
    expect(await rpc.nonce(sender)).toBe(nonce + 1n);
  });
});
