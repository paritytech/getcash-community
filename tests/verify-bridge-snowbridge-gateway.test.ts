// A Snowbridge message sent through the Gateway on a local fork of Ethereum, signed by the bridge
// signer and sent through the bridge's Ethereum client. The fork is a local test node that starts
// from the state of Ethereum, so the key below is the funded one it ships with, and nothing here
// touches the real chain. The test then reads the Gateway's event and builds from it the message
// that Bridge Hub would send to Asset Hub.
// TODO: remove the sending with the signer, once a forwarder and a relayer send the message.
// Run the test soon after the fork starts: the public node gives the state of recent blocks
// only, and a fork older than about 20 minutes fails.
//   anvil --fork-url https://ethereum-rpc.publicnode.com
//   VERIFY_BRIDGE_ETHEREUM_FORK=http://127.0.0.1:8545 pnpm vitest run tests/verify-bridge-snowbridge-gateway.test.ts

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  acceptedMessage,
  accountClaimer,
  claimerBytes,
  createEvmRpc,
  deliveredProgram,
  encodeCall,
  encodeXcm,
  ETHEREUM_CHAIN_ID,
  evmAddressOf,
  EvmRpcError,
  gatewaySend,
  readAccepted,
  signEvmTransaction,
  sizeSnowbridgeTopUp,
  snowbridgeProgram,
  snowbridgeTopic,
  SNOWBRIDGE_GATEWAY,
  wordAt,
  type EvmReceipt,
  type EvmTransactionCall,
} from "@getsome/bridge";

const NODE = process.env.VERIFY_BRIDGE_ETHEREUM_FORK;

/** The first key of the test mnemonic local nodes fund. */
const FUNDED_KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SENDER = evmAddressOf(FUNDED_KEY);
const ACCOUNT = `0x${"42".repeat(32)}`;

/** The amounts of a top-up of 0.05 ETH, sized from costs that the live chains gave. */
const SIZING = sizeSnowbridgeTopUp({
  costs: {
    assetHubExecution: 1_169_966_505_745n,
    hydrationDelivery: 12_530_707_914_008n,
    hydrationExecution: 34_622_646_012_343n,
    depositUsdt: 757n,
    depositEther: 439_497_861_055n,
    etherMinimum: 15_000_000_000_000n,
    bridgeHubDelivery: 12_846_579_360_187n,
    relayerTransaction: 9_809_513_428_701n,
  },
  account: ACCOUNT,
  swapEther: 50_000_000_000_000_000n,
  minimumUsdt: 84_000_000n,
});
const PROGRAM = snowbridgeProgram(SIZING.program);
const CLAIMER = accountClaimer(ACCOUNT);

describe.runIf(NODE !== undefined && NODE !== "")("the Gateway on a local fork of Ethereum", () => {
  const rpc = createEvmRpc(NODE!);

  const nextNonce = async (): Promise<bigint> =>
    wordAt(await rpc.call({ to: SNOWBRIDGE_GATEWAY, data: encodeCall("v2_outboundNonce()") }), 0) +
    1n;

  /** Signs `call` and sends it, and waits for its receipt. */
  async function send(call: EvmTransactionCall): Promise<EvmReceipt> {
    const [chainId, nonce, baseFee, tip, gas] = await Promise.all([
      rpc.chainId(),
      rpc.nonce(SENDER),
      rpc.baseFee(),
      rpc.priorityFee(),
      rpc.estimateGas({ ...call, from: SENDER }),
    ]);
    expect(chainId).toBe(ETHEREUM_CHAIN_ID);
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
    const hash = await rpc.send(signed.raw);
    let receipt = await rpc.receipt(hash);
    for (let waited = 0; receipt === null && waited < 20; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      receipt = await rpc.receipt(hash);
    }
    if (receipt === null) throw new Error("the node gave no receipt");
    return receipt;
  }

  it("accepts the message, and its event carries what was sent", async () => {
    const number = await nextNonce();
    const call = await gatewaySend({
      program: PROGRAM,
      claimer: CLAIMER,
      executionFee: SIZING.executionFee,
      relayerFee: SIZING.relayerFee,
      total: SIZING.total,
    });

    const receipt = await send(call);
    expect(receipt.succeeded).toBe(true);
    console.log(`the Gateway call used ${receipt.gasUsed} gas`);

    const accepted = receipt.logs.flatMap((log) => acceptedMessage(log) ?? []);
    expect(accepted).toHaveLength(1);
    const message = accepted[0]!;
    expect(message).toMatchObject({
      nonce: number,
      sender: SENDER,
      value: SIZING.value,
      executionFee: SIZING.executionFee,
      relayerFee: SIZING.relayerFee,
      tokens: [],
    });
    expect(bytesToHex(message.program)).toBe(bytesToHex(await encodeXcm(PROGRAM)));
    expect(bytesToHex(message.claimer)).toBe(bytesToHex(await claimerBytes(CLAIMER)));

    // What Bridge Hub would send to Asset Hub for this event is the message that was sized and
    // run in the dry runs, with the topic of its number.
    const fromEvent = deliveredProgram(await readAccepted(message));
    const sized = deliveredProgram({
      sender: SENDER,
      nonce: number,
      value: SIZING.value,
      executionFee: SIZING.executionFee,
      claimer: CLAIMER,
      program: PROGRAM,
    });
    expect(bytesToHex(await encodeXcm(fromEvent))).toBe(bytesToHex(await encodeXcm(sized)));
    expect(fromEvent.at(-1)).toEqual({ type: "SetTopic", value: snowbridgeTopic(number) });
  }, 60_000);

  it("gives each message the next number", async () => {
    const number = await nextNonce();
    const call = await gatewaySend({
      program: PROGRAM,
      claimer: CLAIMER,
      executionFee: SIZING.executionFee,
      relayerFee: SIZING.relayerFee,
      total: SIZING.total,
    });
    const receipt = await send(call);
    expect(receipt.logs.flatMap((log) => acceptedMessage(log) ?? [])[0]?.nonce).toBe(number);
    expect(await nextNonce()).toBe(number + 1n);
  }, 60_000);

  it("refuses a call with less ether than its two fees", async () => {
    const call = await gatewaySend({
      program: PROGRAM,
      claimer: CLAIMER,
      executionFee: SIZING.executionFee,
      relayerFee: SIZING.relayerFee,
      total: SIZING.executionFee + SIZING.relayerFee,
    });
    // With exactly the two fees the Gateway takes the call: the message then carries no ether.
    await expect(rpc.estimateGas({ ...call, from: SENDER })).resolves.toBeGreaterThan(0n);
    const short = { ...call, value: call.value - 1n, from: SENDER };
    await expect(rpc.estimateGas(short)).rejects.toThrow(EvmRpcError);
  }, 60_000);
});
