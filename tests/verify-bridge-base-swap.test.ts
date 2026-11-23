// The swap of ETH for USDC on a local fork of Base, signed by the bridge signer and sent through
// the bridge's Ethereum client. The fork is a local test node that starts from the state of Base,
// so the key below is the funded one it ships with, and nothing here touches the real chain. The
// test must be the only sender on the node, because it reads each cost from the latest block.
// TODO: remove this file with the swap, once a forwarder and a relayer make the deposit.
//   anvil --fork-url https://mainnet.base.org
//   VERIFY_BRIDGE_BASE_FORK=http://127.0.0.1:8545 pnpm vitest run tests/verify-bridge-base-swap.test.ts

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  abiAddress,
  BASE_CHAIN_ID,
  BASE_USDC,
  baseDataFee,
  createEvmRpc,
  encodeCall,
  ethToUsdcSwap,
  evmAddressOf,
  EvmRpcError,
  lessTolerance,
  quoteEthIn,
  quoteUsdcOut,
  signEvmTransaction,
  wordAt,
  type EvmReceipt,
  type EvmTransactionCall,
} from "@getsome/bridge";

const NODE = process.env.VERIFY_BRIDGE_BASE_FORK;

/** The first key of the test mnemonic local nodes fund. */
const FUNDED_KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SENDER = evmAddressOf(FUNDED_KEY);

const ETH_IN = 50_000_000_000_000_000n;

describe.runIf(NODE !== undefined && NODE !== "")("the swap on a local fork of Base", () => {
  const rpc = createEvmRpc(NODE!);

  /** A recipient no earlier run has paid, so its USDC starts at zero. */
  const newRecipient = (): string => evmAddressOf(crypto.getRandomValues(new Uint8Array(32)));

  const usdcOf = async (holder: string): Promise<bigint> => {
    const data = encodeCall("balanceOf(address)", [abiAddress(holder)]);
    return wordAt(await rpc.call({ to: BASE_USDC, data }), 0);
  };

  /** Signs `call` and sends it, and waits for its receipt. With no `gasLimit` the node estimates
   *  the gas. `gasCost` is the gas used at the price of the block, and `dataFee` is the data fee
   *  the bridge reads for the signed bytes. */
  async function send(
    call: EvmTransactionCall,
    gasLimit?: bigint,
  ): Promise<{ receipt: EvmReceipt; gasCost: bigint; dataFee: bigint }> {
    const [chainId, nonce, baseFee, tip] = await Promise.all([
      rpc.chainId(),
      rpc.nonce(SENDER),
      rpc.baseFee(),
      rpc.priorityFee(),
    ]);
    expect(chainId).toBe(BASE_CHAIN_ID);
    const gas = gasLimit ?? ((await rpc.estimateGas({ ...call, from: SENDER })) * 12n) / 10n;
    const signed = signEvmTransaction(
      {
        chainId,
        nonce,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: 2n * baseFee + tip,
        gasLimit: gas,
        ...call,
      },
      FUNDED_KEY,
    );
    const hash = await rpc.send(signed.raw);
    let receipt = await rpc.receipt(hash);
    for (let waited = 0; receipt === null && waited < 20; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      receipt = await rpc.receipt(hash);
    }
    if (receipt === null) throw new Error("the node gave no receipt");
    // The latest block is the one that holds the transaction.
    const price = (await rpc.baseFee()) + tip;
    const dataFee = await baseDataFee(rpc, signed.raw);
    return { receipt, gasCost: receipt.gasUsed * price, dataFee };
  }

  /** The node charged a data fee, and the fee the bridge read covers it. */
  function expectDataFeeCovers(charged: bigint, dataFee: bigint): void {
    expect(charged).toBeGreaterThan(0n);
    expect(charged).toBeLessThanOrEqual(dataFee);
  }

  it("pays the recipient the USDC the quoter said, for the ETH, the gas and the data fee", async () => {
    const recipient = newRecipient();
    const quoted = await quoteUsdcOut(rpc, ETH_IN);
    expect(quoted).toBeGreaterThan(0n);
    const before = await rpc.balance(SENDER);

    const { receipt, gasCost, dataFee } = await send(
      ethToUsdcSwap({ ethIn: ETH_IN, minimumUsdcOut: lessTolerance(quoted, 50n), recipient }),
    );

    expect(receipt.succeeded).toBe(true);
    expect(await usdcOf(recipient)).toBe(quoted);
    const spent = before - (await rpc.balance(SENDER));
    expectDataFeeCovers(spent - ETH_IN - gasCost, dataFee);
  });

  it("buys a wanted amount of USDC with the ETH the quoter said", async () => {
    const recipient = newRecipient();
    const wanted = 25_000_000n;
    const ethIn = await quoteEthIn(rpc, wanted);

    // The pool rounds in its own favour, so the last base unit can go missing.
    const { receipt } = await send(
      ethToUsdcSwap({ ethIn, minimumUsdcOut: wanted - 1n, recipient }),
    );

    expect(receipt.succeeded).toBe(true);
    const received = await usdcOf(recipient);
    expect(received).toBeGreaterThanOrEqual(wanted - 1n);
    expect(received).toBeLessThanOrEqual(wanted);
  });

  it("reverts and keeps the ETH when the pool pays less than the minimum", async () => {
    const recipient = newRecipient();
    const quoted = await quoteUsdcOut(rpc, ETH_IN);
    const call = ethToUsdcSwap({ ethIn: ETH_IN, minimumUsdcOut: quoted + 1n, recipient });

    // The node refuses to estimate the gas, so the fault shows before anything is sent.
    const refusal = await rpc.estimateGas({ ...call, from: SENDER }).catch((error) => error);
    expect(refusal).toBeInstanceOf(EvmRpcError);
    expect((refusal as EvmRpcError).message).toContain("Too little received");

    const before = await rpc.balance(SENDER);
    const { receipt, gasCost, dataFee } = await send(call, 300_000n);
    expect(receipt.succeeded).toBe(false);
    expect(await usdcOf(recipient)).toBe(0n);
    const spent = before - (await rpc.balance(SENDER));
    expectDataFeeCovers(spent - gasCost, dataFee);
  });
});
