// The Base route on a local fork of Base, signed by the bridge signer: the swap of ETH for USDC,
// the approval, and the deposit into the vault. The fork is a local test node that starts from
// the state of Base, so the key below is the funded one it ships with, and nothing here touches
// the real chain. The facilitator is read on live Hydration, and nothing is sent there. The test
// must be the only sender on the node, so run it apart from the other tests of the fork.
// TODO: remove the three transactions, once a forwarder and a relayer make the deposit.
//   anvil --fork-url https://mainnet.base.org
//   VERIFY_BRIDGE_BASE_FORK=http://127.0.0.1:8545 pnpm vitest run tests/verify-bridge-base-vault.test.ts

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  approveVault,
  BASE_CHAIN_ID,
  createEvmRpc,
  ethToUsdcSwap,
  evmAddressOf,
  EvmRpcError,
  quoteEthIn,
  quoteUsdcOut,
  readVault,
  signEvmTransaction,
  vaultDeposit,
  vaultDeposited,
  vaultRefusal,
  type EvmReceipt,
  type EvmTransactionCall,
} from "@getsome/bridge";

const NODE = process.env.VERIFY_BRIDGE_BASE_FORK;
const HYDRATION = "https://rpc.hydradx.cloud";

/** The first key of the test mnemonic local nodes fund. */
const FUNDED_KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SENDER = evmAddressOf(FUNDED_KEY);

describe.runIf(NODE !== undefined && NODE !== "")("the vault on a local fork of Base", () => {
  const base = createEvmRpc(NODE!);
  const hydration = createEvmRpc(HYDRATION);

  /** Signs `call` and sends it, and waits for its receipt. */
  async function send(call: EvmTransactionCall): Promise<EvmReceipt> {
    const [chainId, nonce, baseFee, tip, gas] = await Promise.all([
      base.chainId(),
      base.nonce(SENDER),
      base.baseFee(),
      base.priorityFee(),
      base.estimateGas({ ...call, from: SENDER }),
    ]);
    expect(chainId).toBe(BASE_CHAIN_ID);
    const signed = signEvmTransaction(
      {
        chainId,
        nonce,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: 2n * baseFee + tip,
        gasLimit: (gas * 12n) / 10n,
        ...call,
      },
      FUNDED_KEY,
    );
    const hash = await base.send(signed.raw);
    let receipt = await base.receipt(hash);
    for (let waited = 0; receipt === null && waited < 20; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      receipt = await base.receipt(hash);
    }
    if (receipt === null) throw new Error("the node gave no receipt");
    expect(receipt.succeeded).toBe(true);
    return receipt;
  }

  /** Buys `usdc` of USDC for the sender, with 1% more ETH than the quote and the USDC as the
   *  minimum. */
  async function buy(usdc: bigint): Promise<void> {
    const ethIn = ((await quoteEthIn(base, usdc)) * 101n) / 100n;
    expect(await quoteUsdcOut(base, ethIn)).toBeGreaterThanOrEqual(usdc);
    await send(ethToUsdcSwap({ ethIn, minimumUsdcOut: usdc, recipient: SENDER }));
  }

  it("takes a deposit that fits its room, and says for whom and how much", async () => {
    const usdc = 85_000_000n;
    const recipient = evmAddressOf(crypto.getRandomValues(new Uint8Array(32)));
    await buy(usdc);

    // The room is read just before the deposit.
    const before = await readVault(base, hydration);
    console.log("the vault and the facilitator", before);
    expect(vaultRefusal(before, usdc)).toBeNull();

    await send(approveVault(usdc));
    const receipt = await send(vaultDeposit({ usdc, recipient, messageFee: before.messageFee }));
    const deposits = receipt.logs.flatMap((log) => vaultDeposited(log) ?? []);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({ from: SENDER, recipient, usdc });
    console.log(
      `the deposit used ${receipt.gasUsed} gas; its message has the number ${deposits[0]!.sequence}`,
    );

    // The room of the vault is now smaller by the deposit, less what it gained back with time.
    const after = await readVault(base, hydration);
    expect(after.depositAllowance).toBeLessThan(before.depositAllowance);
    expect(after.depositAllowance).toBeGreaterThanOrEqual(before.depositAllowance - usdc);
  }, 120_000);

  it("refuses a deposit over its room, in the check and on the chain", async () => {
    const state = await readVault(base, hydration);
    const usdc = state.depositAllowance + 1_000_000n;
    const recipient = evmAddressOf(crypto.getRandomValues(new Uint8Array(32)));
    await buy(usdc);
    await send(approveVault(usdc));

    expect(vaultRefusal(state, usdc)).toContain("room for");
    const deposit = vaultDeposit({ usdc, recipient, messageFee: state.messageFee });
    await expect(base.estimateGas({ ...deposit, from: SENDER })).rejects.toThrow(EvmRpcError);

    // One base unit of room less than the vault has, and it takes the deposit.
    const fits = (await readVault(base, hydration)).depositAllowance;
    const call = vaultDeposit({ usdc: fits, recipient, messageFee: state.messageFee });
    await expect(base.estimateGas({ ...call, from: SENDER })).resolves.toBeGreaterThan(0n);
  }, 120_000);
});
