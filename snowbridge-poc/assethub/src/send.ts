import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ApiPromise } from "@polkadot/api";
import type { EventRecord } from "@polkadot/types/interfaces";
import { u8aToHex } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { BUILD_DIR, DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT } from "./constants.js";
import type { BridgeMessage } from "./delivered.js";
import { readDeployment } from "./deployment.js";
import { json, poolEvents, type ChainEvent } from "./effects.js";
import { deployerClient, publicClient, snowbridgeContracts } from "./ethereum.js";
import { quoteDelivery } from "./fees.js";
import { callView, foreignBalance } from "./revive.js";
import { assembleClaimer, assembleXcm, buildTemplate } from "./template.js";

const tokenAbi = parseAbi(["function mint(address account, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)", "function gateway() view returns (address)"]);
const gatewayAbi = parseAbi(["function v2_sendMessage(bytes xcm, bytes[] assets, bytes claimer, uint128 executionFee, uint128 relayerFee) payable"]);
const poolAbi = (JSON.parse(readFileSync(`${BUILD_DIR}/Pool.json`, "utf8")) as { abi: Abi }).abi;

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "//Bob" },
    amount: { type: "string", default: "5000000000000000000" },
    "deposit-id": { type: "string", default: "100" },
    "timeout-seconds": { type: "string", default: "420" },
  },
});

async function isSettled(api: ApiPromise, pool: Address, caller: Hex, depositId: bigint): Promise<boolean> {
  const data = encodeFunctionData({ abi: poolAbi, functionName: "settled", args: [depositId] });
  return BigInt(await callView(api, caller, pool, data)) === 1n;
}

/** Looks through recent blocks for the pool's events and the block that carried them. */
async function findPoolEvents(api: ApiPromise, pool: Address, depth: number) {
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  for (let number = head; number > head - depth; number--) {
    const hash = await api.rpc.chain.getBlockHash(number);
    const records = (await (await api.at(hash)).query.system.events()) as unknown as EventRecord[];
    const events: ChainEvent[] = records.map(({ event }) => ({
      section: event.section,
      method: event.method,
      fields: Object.fromEntries(event.data.map((value, i) => [event.data.names?.[i] ?? i, value.toJSON()])),
    }));
    const emitted = poolEvents(events, poolAbi, pool);
    if (emitted.some((e) => e.eventName === "Settled")) {
      const processed = events.find((e) => e.section === "messageQueue" && e.method === "Processed");
      return { number, hash: hash.toHex(), emitted, processed };
    }
  }
  return undefined;
}

const deployment = readDeployment();
const { gateway, token } = snowbridgeContracts();
const { account: sender, wallet } = deployerClient();
if (getAddress(sender.address) !== getAddress(deployment.router)) {
  throw new Error(`the pool trusts ${deployment.router}, not the deployer ${sender.address}; deploy it with --router ${sender.address}`);
}

const api = await connect();
try {
  const user = u8aToHex(devKeyring(values.user!).publicKey);
  const userSs58 = encodeAddress(user, 42);
  const amount = BigInt(values.amount!);
  const depositId = BigInt(values["deposit-id"]!);

  const template = await buildTemplate(api, {
    pool: deployment.pool,
    feeAccount: deployment.feeAccount,
    weightLimit: DEFAULT_SETTLE_WEIGHT,
    storageDepositLimit: DEFAULT_STORAGE_DEPOSIT_LIMIT,
  });
  const message: BridgeMessage = {
    router: sender.address,
    nonce: 0n,
    xcm: assembleXcm(template, { depositId, account: user, token: deployment.token, amount }),
    claimer: assembleClaimer(template, user),
    value: 0n,
    executionFee: 1n,
    assets: [{ token: deployment.token, amount }],
  };
  const executionFee = ((await quoteDelivery(api, message)).fee * 15n) / 10n;
  console.log(`execution fee ${executionFee} wei for ${deployment.pool}, deposit ${depositId}, user ${userSs58}`);

  const send = async (request: { functionName: string } & Record<string, unknown>) => {
    const hash = await wallet.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${request.functionName} ${hash} ${receipt.status} (block ${receipt.blockNumber})`);
  };
  if (getAddress(await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "gateway" })) === getAddress(sender.address)) {
    await send({ address: token, abi: tokenAbi, functionName: "mint", args: [sender.address, amount] });
  }
  await send({ address: token, abi: tokenAbi, functionName: "approve", args: [gateway, amount] });
  const asset = encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint128" }], [0, token, amount]);
  await send({
    address: gateway,
    abi: gatewayAbi,
    functionName: "v2_sendMessage",
    args: [message.xcm, [asset], message.claimer, executionFee, 0n],
    value: executionFee,
  });

  const before = await foreignBalance(api, token, userSs58);
  const deadline = Date.now() + Number(values["timeout-seconds"]) * 1000;
  const started = Date.now();
  while (!(await isSettled(api, deployment.pool, user, depositId))) {
    if (Date.now() > deadline) throw new Error("the deposit was not settled in time");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log(`settled on Asset Hub ${Math.round((Date.now() - started) / 1000)} s after the Gateway call`);
  console.log(`  user balance ${before} -> ${await foreignBalance(api, token, userSs58)}`);
  const owed = BigInt(await callView(api, user, deployment.pool, encodeFunctionData({ abi: poolAbi, functionName: "owed", args: [user, deployment.token] })));
  console.log(`  owed to the user in the pool: ${owed}`);
  const found = await findPoolEvents(api, deployment.pool, 60);
  if (found) {
    console.log(`  block ${found.number} ${found.hash}; message queue ${json(found.processed?.fields)}`);
    for (const event of found.emitted) console.log(`  pool ${event.eventName} ${json(event.args)}`);
  }
} finally {
  await api.disconnect();
}
