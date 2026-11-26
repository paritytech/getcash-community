// An Ethereum transaction as a move, over a scripted node: what it reads before it signs, the
// fields it signs, and how it finds the transaction again.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { evmMove } from "./evm-move";
import { EvmRpcError, type EvmCall, type EvmReceipt, type EvmRpc } from "./evm-rpc";
import { evmAddressOf, signEvmTransaction, type EvmTransactionCall } from "./evm-tx";
import { BridgeMoveRefused } from "./leg";

const KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SENDER = evmAddressOf(KEY);
const CHAIN = 8453n;
const CALL: EvmTransactionCall = {
  to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  value: 1_000_000_000_000_000n,
  data: Uint8Array.of(0xab, 0xcd),
};

interface NodeScript {
  nonce?: bigint;
  baseFee?: bigint;
  tip?: bigint;
  gas?: bigint | Error;
  receipt?: EvmReceipt | null;
}

/** A node that answers from `script`, and what it was asked. */
function node(script: NodeScript = {}) {
  const asked: string[] = [];
  const estimated: EvmCall[] = [];
  const sent: Uint8Array[] = [];
  const receipts: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("the move must not ask this");
  };
  const rpc: EvmRpc = {
    chainId: unused,
    balance: unused,
    call: unused,
    nonce: async (address) => {
      asked.push(`nonce ${address}`);
      return script.nonce ?? 7n;
    },
    baseFee: async () => {
      asked.push("baseFee");
      return script.baseFee ?? 1_000_000_000n;
    },
    priorityFee: async () => {
      asked.push("priorityFee");
      return script.tip ?? 50_000_000n;
    },
    estimateGas: async (call) => {
      asked.push("estimateGas");
      estimated.push(call);
      if (script.gas instanceof Error) throw script.gas;
      return script.gas ?? 100_000n;
    },
    send: async (raw) => {
      sent.push(raw);
      return `0x${bytesToHex(keccak_256(raw))}`;
    },
    receipt: async (hash) => {
      receipts.push(hash);
      return script.receipt ?? null;
    },
  };
  return { rpc, asked, estimated, sent, receipts };
}

const moveOn = (rpc: EvmRpc, build: () => Promise<EvmTransactionCall> = async () => CALL) =>
  evmMove({ rpc, chainId: CHAIN, privateKey: KEY, build });

const RECEIPT: EvmReceipt = { succeeded: true, blockNumber: 12n, gasUsed: 90_000n, logs: [] };

describe("evmMove, the run that signs", () => {
  it("signs the call with the key's nonce, the fees of the node and gas to spare", async () => {
    const { rpc, sent } = node();
    const prepared = await moveOn(rpc).prepare();
    const expected = signEvmTransaction(
      {
        chainId: CHAIN,
        nonce: 7n,
        maxPriorityFeePerGas: 50_000_000n,
        maxFeePerGas: 2_050_000_000n,
        gasLimit: 120_000n,
        ...CALL,
      },
      KEY,
    );
    expect(prepared).toBe(`0x${bytesToHex(expected.raw)}`);
    expect(sent).toEqual([]);
  });

  it("reads the nonce of the key's own address and estimates the call as sent by it", async () => {
    const { rpc, asked, estimated } = node();
    await moveOn(rpc).prepare();
    expect([...asked].sort()).toEqual(["baseFee", "estimateGas", `nonce ${SENDER}`, "priorityFee"]);
    expect(estimated).toEqual([{ ...CALL, from: SENDER }]);
  });

  it.each<[bigint, bigint]>([
    [21_000n, 25_200n],
    [100_001n, 120_001n],
    [4n, 4n],
  ])("adds a fifth to an estimate of %s gas", async (gas, gasLimit) => {
    const { rpc } = node({ gas });
    const prepared = await moveOn(rpc).prepare();
    const expected = signEvmTransaction(
      {
        chainId: CHAIN,
        nonce: 7n,
        maxPriorityFeePerGas: 50_000_000n,
        maxFeePerGas: 2_050_000_000n,
        gasLimit,
        ...CALL,
      },
      KEY,
    );
    expect(prepared).toBe(`0x${bytesToHex(expected.raw)}`);
  });

  it("signs for the chain it was given, so that another chain refuses the bytes", async () => {
    const { rpc } = node();
    const onBase = await moveOn(rpc).prepare();
    const onEthereum = await evmMove({
      rpc,
      chainId: 1n,
      privateKey: KEY,
      build: async () => CALL,
    }).prepare();
    expect(onEthereum).not.toBe(onBase);
  });

  it("passes on the refusal of the call, and reads nothing", async () => {
    const { rpc, asked } = node();
    const move = moveOn(rpc, async () => {
      throw new BridgeMoveRefused("the vault has no room");
    });
    const error = await move.prepare().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeMoveRefused);
    expect(asked).toEqual([]);
  });

  it("does not sign a call that the node says would fail", async () => {
    const reverted = new EvmRpcError("eth_estimateGas", 3, "execution reverted");
    const { rpc } = node({ gas: reverted });
    await expect(moveOn(rpc).prepare()).rejects.toBe(reverted);
  });
});

describe("evmMove, the send and the search", () => {
  const prepared = "0x02f8730182";

  it("sends the prepared bytes as they are", async () => {
    const { rpc, sent } = node();
    expect(await moveOn(rpc).send(prepared)).toBeUndefined();
    expect(sent).toEqual([hexToBytes("02f8730182")]);
  });

  it("looks for the transaction by the hash of its bytes", async () => {
    const { rpc, receipts } = node();
    await moveOn(rpc).landed(prepared);
    expect(receipts).toEqual([`0x${bytesToHex(keccak_256(hexToBytes("02f8730182")))}`]);
  });

  it.each<[string, EvmReceipt | null, string]>([
    ["no receipt", null, "not-yet"],
    ["a receipt of a run to the end", RECEIPT, "yes"],
    ["a receipt of a run that failed", { ...RECEIPT, succeeded: false }, "failed"],
  ])("reads %s", async (_name, receipt, landed) => {
    const { rpc } = node({ receipt });
    expect(await moveOn(rpc).landed(prepared)).toBe(landed);
  });

  it("finds by its hash the transaction it prepared", async () => {
    const { rpc, sent, receipts } = node();
    const move = moveOn(rpc);
    const signed = await move.prepare();
    await move.send(signed);
    await move.landed(signed);
    expect(receipts).toEqual([`0x${bytesToHex(keccak_256(sent[0]!))}`]);
  });
});
