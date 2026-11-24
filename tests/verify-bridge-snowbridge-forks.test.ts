// A Snowbridge top-up from end to end on local forks, with nothing sent to a real chain. The
// Gateway on a fork of Ethereum accepts the message. The message its event leads to goes into a
// block of a fork of Asset Hub, as Bridge Hub would deliver it. What each fork sends on goes into
// a block of the next fork as it is: Hydration, then Asset Hub again. The balances are then read
// from the fork.
// TODO: remove the sending with the signer, once a forwarder and a relayer send the message.
//   anvil --fork-url https://ethereum-rpc.publicnode.com --port 8557
//   npx @acala-network/chopsticks@1.5.2 --endpoint wss://rpc.hydradx.cloud --port 8012
//   npx @acala-network/chopsticks@1.5.2 --endpoint wss://polkadot-asset-hub-rpc.polkadot.io --port 8013
//   VERIFY_BRIDGE_ETHEREUM_FORK=http://127.0.0.1:8557 VERIFY_BRIDGE_HYDRATION_FORK=ws://127.0.0.1:8012 \
//   VERIFY_BRIDGE_ASSET_HUB_FORK=ws://127.0.0.1:8013 pnpm vitest run tests/verify-bridge-snowbridge-forks.test.ts

import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptedMessage,
  accountClaimer,
  chainReader,
  createEvmRpc,
  deliveredProgram,
  encodeXcm,
  ETHER,
  evmAddressOf,
  gatewaySend,
  readAccepted,
  readSnowbridgeCosts,
  runSnowbridgeHops,
  signEvmTransaction,
  sizeSnowbridgeTopUp,
  snowbridgeProgram,
  type SnowbridgeCosts,
  type SnowbridgeMessage,
  type SnowbridgeSizing,
  type XcmInstruction,
} from "@getsome/bridge";
import { deriveKeypair } from "@getsome/ephemeral";

const ETHEREUM = process.env.VERIFY_BRIDGE_ETHEREUM_FORK;
const HYDRATION = process.env.VERIFY_BRIDGE_HYDRATION_FORK;
const ASSET_HUB = process.env.VERIFY_BRIDGE_ASSET_HUB_FORK;
const BRIDGE_HUB = "wss://polkadot-bridge-hub-rpc.polkadot.io";
const ON = [ETHEREUM, HYDRATION, ASSET_HUB].every((url) => url !== undefined && url !== "");

/** The first key of the test mnemonic local nodes fund. */
const FUNDED_KEY = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SENDER = evmAddressOf(FUNDED_KEY);
const SWAP = 50_000_000_000_000_000n;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fork = { client: PolkadotClient; api: any };
type Block = { hash: string; events: { pallet: string; name: string; fields: any }[]; sent: any[] };

/** A number as SCALE writes the length of a list. */
function compact(value: number): Uint8Array {
  if (value < 64) return Uint8Array.of(value << 2);
  if (value < 16_384) return Uint8Array.of(((value << 2) | 1) & 0xff, value >> 6);
  throw new Error("the message is too long for this test");
}

const bytesOf = (data: any): Uint8Array =>
  typeof data === "string" ? hexToBytes(data.replace(/^0x/, "")) : data;

describe.runIf(ON)("a Snowbridge top-up on local forks", () => {
  const rpc = createEvmRpc(ETHEREUM!);
  const clients: PolkadotClient[] = [];
  let assetHub: Fork;
  let hydration: Fork;
  let costs: SnowbridgeCosts;
  let usdtOut: bigint;

  const connect = (url: string): Fork => {
    const client = createClient(getWsProvider(url));
    clients.push(client);
    return { client, api: client.getUnsafeApi() };
  };

  /** A read of a fork at a block it has just made. The client learns of the block a moment
   *  after the fork makes it. */
  async function soon<T>(read: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await read();
      } catch (error) {
        if (tries === 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  /** Makes a block on `fork` that receives `page` from the parachain `from`. */
  async function receive(fork: Fork, from: number, page: Uint8Array): Promise<Block> {
    const hash: string = await fork.client._request("dev_newBlock", [
      { hrmp: { [from]: [{ sentAt: 0, data: `0x${bytesToHex(page)}` }] } },
    ]);
    const at = { at: hash };
    const records: any[] = await soon(() => fork.api.query.System.Events.getValue(at));
    const sent: any[] = await soon(() =>
      fork.api.query.ParachainSystem.HrmpOutboundMessages.getValue(at),
    );
    const events = records.map(({ event }) => ({
      pallet: event.type,
      name: event.value.type,
      fields: event.value.value ?? {},
    }));
    return { hash, events, sent };
  }

  /** Whether the block ran the message from `from` to its end. */
  const ranFrom = (block: Block, from: number): boolean | undefined =>
    block.events.find(
      (e) =>
        e.pallet === "MessageQueue" && e.name === "Processed" && e.fields.origin?.value === from,
    )?.fields.success;

  /** The page the block sends to the parachain `to`. */
  const pageTo = (block: Block, to: number): Uint8Array | null => {
    const message = block.sent.find((entry) => entry.recipient === to);
    return message === undefined ? null : bytesOf(message.data);
  };

  /** Bridge Hub's page for one message: the kind of page, the length of the message, the message. */
  const fromBridgeHub = async (program: XcmInstruction[]): Promise<Uint8Array> => {
    const bytes = await encodeXcm(program);
    return concatBytes(Uint8Array.of(3), compact(bytes.length), bytes);
  };

  /** Sends the sized message through the Gateway on the Ethereum fork, and gives the message
   *  that Bridge Hub would deliver for its event. */
  async function throughGateway(account: string, sizing: SnowbridgeSizing) {
    const call = await gatewaySend({
      program: snowbridgeProgram(sizing.program),
      claimer: accountClaimer(account),
      executionFee: sizing.executionFee,
      relayerFee: sizing.relayerFee,
      total: sizing.total,
    });
    const [chainId, nonce, baseFee, tip, gas] = await Promise.all([
      rpc.chainId(),
      rpc.nonce(SENDER),
      rpc.baseFee(),
      rpc.priorityFee(),
      rpc.estimateGas({ ...call, from: SENDER }),
    ]);
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
    const receipt = await soon(async () => {
      const found = await rpc.receipt(hash);
      if (found === null) throw new Error("the node gave no receipt");
      return found;
    });
    expect(receipt.succeeded).toBe(true);
    const accepted = receipt.logs.flatMap((log) => acceptedMessage(log) ?? []);
    expect(accepted).toHaveLength(1);
    return readAccepted(accepted[0]!);
  }

  /** The three hops in blocks of the forks. Each fork gets what the fork before sent, as it is. */
  async function inBlocks(message: SnowbridgeMessage) {
    const first = await receive(assetHub, 1002, await fromBridgeHub(deliveredProgram(message)));
    const toHydration = pageTo(first, 2034);
    const second = toHydration === null ? null : await receive(hydration, 1000, toHydration);
    const back = second === null ? null : pageTo(second, 1000);
    const third = back === null ? null : await receive(assetHub, 2034, back);
    return { first, second, third };
  }

  const dryRunChains = () => ({
    assetHub: chainReader(assetHub.api),
    hydration: chainReader(hydration.api),
  });

  const newAccount = () => {
    const keys = deriveKeypair(crypto.getRandomValues(new Uint8Array(32)));
    return { ...keys, hex: `0x${bytesToHex(keys.publicKey)}` };
  };

  /** What an account holds on the Asset Hub fork at the block `at`. */
  const held = async (entry: any, id: unknown, address: string, at: string): Promise<bigint> =>
    (await soon<any>(() => entry.getValue(id, address, { at })))?.balance ?? 0n;
  const usdtOf = (address: string, at: string) =>
    held(assetHub.api.query.Assets.Account, 1984, address, at);
  const etherOf = (address: string, at: string) =>
    held(assetHub.api.query.ForeignAssets.Account, ETHER, address, at);

  beforeAll(async () => {
    assetHub = connect(ASSET_HUB!);
    hydration = connect(HYDRATION!);
    const bridgeHub = connect(BRIDGE_HUB);
    // The costs come from the forks, so that the amounts fit the state the blocks run on.
    const account = newAccount();
    const trial = await readSnowbridgeCosts(
      {
        assetHub: chainReader(assetHub.api),
        bridgeHub: chainReader(bridgeHub.api),
        hydration: chainReader(hydration.api),
      },
      {
        sender: SENDER,
        nonce: 1n,
        value: SWAP + 1_015_000_000_000_000n,
        executionFee: 1_000_000_000_000_000n,
        claimer: accountClaimer(account.hex),
        program: snowbridgeProgram({
          account: account.hex,
          swapEther: SWAP,
          hydrationFeeEther: 1_000_000_000_000_000n,
          minimumUsdt: 1n,
          assetHubFeeUsdt: 200_000n,
          assetHubFeeEther: 1_000_000_000_000_000n,
        }),
      },
    );
    costs = trial.costs;
    usdtOut = trial.usdtOut;
    console.log("costs on the forks", costs, "USDT for 0.05 ETH", usdtOut);
  }, 180_000);
  afterAll(() => clients.forEach((client) => client.destroy()));

  it("credits the account with the USDT the dry runs said, to one part in 10,000", async () => {
    const account = newAccount();
    const sizing = sizeSnowbridgeTopUp({
      costs,
      account: account.hex,
      swapEther: SWAP,
      minimumUsdt: (usdtOut * 99n) / 100n,
    });
    const message = await throughGateway(account.hex, sizing);

    const said = await runSnowbridgeHops(dryRunChains(), message, account.hex);
    expect(said.assetHub.failure).toBeNull();
    expect(said.hydration?.failure).toBeNull();
    expect(said.deposit?.failure).toBeNull();

    const { first, second, third } = await inBlocks(message);
    expect(ranFrom(first, 1002)).toBe(true);
    expect(ranFrom(second!, 1000)).toBe(true);
    expect(ranFrom(third!, 2034)).toBe(true);
    const usdt = await usdtOf(account.address, third!.hash);
    const ether = await etherOf(account.address, third!.hash);
    console.log(
      `the dry runs said ${said.usdt} USDT and ${said.etherKept} wei; the account holds ${usdt} USDT and ${ether} wei`,
    );
    expect(usdt).toBeGreaterThanOrEqual(sizing.program.minimumUsdt);
    // The swap in a block can pay a little more or less than the dry run before it said. The
    // minimum of the program is the guard for that.
    const off = usdt > said.usdt ? usdt - said.usdt : said.usdt - usdt;
    expect(off).toBeLessThan(said.usdt / 10_000n);
    expect(ether).toBe(said.etherKept);
  }, 600_000);

  it("gives the account its ether back when the swap fails", async () => {
    const account = newAccount();
    const sizing = sizeSnowbridgeTopUp({
      costs,
      account: account.hex,
      swapEther: SWAP,
      minimumUsdt: 2n * usdtOut,
    });
    const message = await throughGateway(account.hex, sizing);

    const said = await runSnowbridgeHops(dryRunChains(), message, account.hex);
    expect(said.hydration?.failure).toMatchObject({ error: "NoDeal" });
    expect(said.deposit?.failure).toBeNull();

    const { first, second, third } = await inBlocks(message);
    expect(ranFrom(first, 1002)).toBe(true);
    // The swap stops the program on Hydration, and the ether still leaves for Asset Hub.
    expect(ranFrom(second!, 1000)).toBe(false);
    expect(ranFrom(third!, 2034)).toBe(true);
    const ether = await etherOf(account.address, third!.hash);
    console.log(
      `the dry runs said ${said.ether} + ${said.etherKept} wei; the account holds ${ether} wei of ${SWAP} swapped`,
    );
    expect(await usdtOf(account.address, third!.hash)).toBe(0n);
    expect(said.ether).toBeGreaterThan((SWAP * 999n) / 1000n);
    // The first hop moves the pool that prices the fee of the last hop, so the blocks charge a
    // little more for the deposit than the dry runs said.
    const short = said.ether + said.etherKept - ether;
    expect(short).toBeGreaterThanOrEqual(0n);
    expect(short).toBeLessThan(costs.depositEther / 1000n);
  }, 600_000);

  it("lets the account claim the ether of a message that stops on Asset Hub", async () => {
    const account = newAccount();
    const sizing = sizeSnowbridgeTopUp({
      costs,
      account: account.hex,
      swapEther: SWAP,
      minimumUsdt: (usdtOut * 99n) / 100n,
    });
    // An execution fee 1% under what Asset Hub charges: it pays for the message, and not in full
    // for its delivery to Hydration.
    const executionFee = (sizing.executionFee / 3n / 100n) * 99n;
    const message = await throughGateway(account.hex, {
      ...sizing,
      executionFee,
      total: sizing.total - sizing.executionFee + executionFee,
    });
    const said = await runSnowbridgeHops(dryRunChains(), message, account.hex);
    expect(said.assetHub.failure).toMatchObject({ error: "NotHoldingFees" });

    const { first, second } = await inBlocks(message);
    expect(ranFrom(first, 1002)).toBe(false);
    expect(second).toBeNull();
    const traps = first.events.filter(
      (e) => e.pallet === "PolkadotXcm" && e.name === "AssetsTrapped",
    );
    expect(traps).toHaveLength(1);
    const trapped = traps[0]!.fields.assets;
    const amount: bigint = trapped.value[0].fun.value;
    expect(trapped.value).toHaveLength(1);
    expect(amount).toBeGreaterThan(SWAP);
    expect(await etherOf(account.address, first.hash)).toBe(0n);

    // The account holds nothing, so it cannot pay for a transaction. It gets 1 DOT here, as a
    // recovery would send it.
    await assetHub.client._request("dev_setStorage", [
      {
        System: { Account: [[[account.address], { providers: 1, data: { free: "10000000000" } }]] },
      },
    ]);
    const claim = await assetHub.api.tx.PolkadotXcm.claim_assets({
      assets: trapped,
      beneficiary: {
        type: "V5",
        value: {
          parents: 0,
          interior: {
            type: "X1",
            value: { type: "AccountId32", value: { network: undefined, id: account.hex } },
          },
        },
      },
    }).signAndSubmit(account.signer);
    expect(claim.ok).toBe(true);
    const held = await etherOf(account.address, claim.block.hash);
    console.log(`trapped ${amount} wei; the account claimed it and holds ${held} wei`);
    expect(held).toBe(amount);
  }, 600_000);
});
