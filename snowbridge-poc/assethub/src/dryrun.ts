import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ApiPromise } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import type { Abi, Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { BUILD_DIR, DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT, ETHEREUM_CHAIN_ID } from "./constants.js";
import type { BridgeMessage } from "./delivered.js";
import { readDeployment } from "./deployment.js";
import { dryRunFromBridgeHub, json, poolEvents, sum } from "./effects.js";
import { quoteDelivery } from "./fees.js";
import { ethereumSenderAccount, reviveAddress } from "./location.js";
import { dryRunCall, isMapped, signAndWait } from "./revive.js";
import { assembleClaimer, assembleXcm, buildTemplate } from "./template.js";
import { mapAccountCall, settleCalldata, transactAsSovereign } from "./xcm.js";

const ROUTER_MIN_BALANCE = 5_000_000_000_000n;

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "//Bob" },
    amount: { type: "string", default: "1000000000000000000" },
    nonce: { type: "string", default: "1001" },
    "deposit-id": { type: "string", default: "1" },
    "execution-fee": { type: "string" },
    "weight-ref-time": { type: "string", default: DEFAULT_SETTLE_WEIGHT.refTime.toString() },
    "weight-proof-size": { type: "string", default: DEFAULT_SETTLE_WEIGHT.proofSize.toString() },
    "storage-deposit-limit": { type: "string", default: DEFAULT_STORAGE_DEPOSIT_LIMIT.toString() },
    "map-account": { type: "boolean", default: false },
    "drain-router": { type: "boolean", default: false },
    "worst-path": { type: "boolean", default: false },
    fund: { type: "boolean", default: false },
  },
});

async function freeBalance(api: ApiPromise, account: Hex): Promise<bigint> {
  const info = (await api.query.system.account(account)) as unknown as { data: { free: { toBigInt(): bigint } } };
  return info.data.free.toBigInt();
}

async function fundRouter(api: ApiPromise, account: Hex): Promise<void> {
  const balance = await freeBalance(api, account);
  if (balance >= ROUTER_MIN_BALANCE) return;
  const included = await signAndWait(api, api.tx.balances.transferKeepAlive(account, ROUTER_MIN_BALANCE - balance), devKeyring("//Alice"));
  console.log(`funded router account from //Alice in ${included.blockHash} (extrinsic ${included.extrinsicHash})`);
}

async function main() {
  const deployment = readDeployment();
  const api = await connect();
  try {
    const router = deployment.router;
    const routerAccount = ethereumSenderAccount(ETHEREUM_CHAIN_ID, router);
    if (values.fund) await fundRouter(api, routerAccount);
    if (reviveAddress(routerAccount).toLowerCase() !== deployment.settler.toLowerCase()) {
      throw new Error("the pool was deployed for another router");
    }
    console.log(`router ${router}: account ${routerAccount}, revive address ${reviveAddress(routerAccount)}`);
    console.log(`  free balance ${await freeBalance(api, routerAccount)}, mapped ${await isMapped(api, routerAccount)}`);

    const user = u8aToHex(devKeyring(values.user!).publicKey);
    const amount = BigInt(values.amount!);
    const weightLimit = { refTime: BigInt(values["weight-ref-time"]!), proofSize: BigInt(values["weight-proof-size"]!) };
    const template = await buildTemplate(api, {
      pool: deployment.pool,
      feeAccount: deployment.feeAccount,
      weightLimit,
      storageDepositLimit: BigInt(values["storage-deposit-limit"]!),
    });
    const message: BridgeMessage = {
      router,
      nonce: BigInt(values.nonce!),
      xcm: assembleXcm(template, { depositId: BigInt(values["deposit-id"]!), account: user, token: deployment.token, amount }),
      claimer: assembleClaimer(template, user),
      value: 0n,
      executionFee: 0n,
      assets: [{ token: deployment.token, amount }],
    };
    const alice = u8aToHex(devKeyring("//Alice").publicKey);
    const setup = [
      ...(values["map-account"] ? [transactAsSovereign(mapAccountCall(api))] : []),
      ...(values["drain-router"] ? [transactAsSovereign(api.tx.balances.transferAll(alice, true).method.toHex())] : []),
    ];

    const quoted = await quoteDelivery(api, { ...message, executionFee: 1n }, setup);
    const executionFee = values["execution-fee"] ? BigInt(values["execution-fee"]) : (quoted.fee * 12n) / 10n;
    const { program, weight } = await quoteDelivery(api, { ...message, executionFee }, setup);
    console.log(`program weight ${json(weight)}; execution fee quoted ${quoted.fee} wei, provided ${executionFee} wei`);

    const { outcome, events } = await dryRunFromBridgeHub(api, program);
    console.log(`outcome ${json(outcome)}`);
    const used = (outcome.complete as { used: { refTime: number; proofSize: number } } | undefined)?.used;
    if (used) {
      const settle = { refTime: Number(weightLimit.refTime) - (weight.refTime - used.refTime), proofSize: Number(weightLimit.proofSize) - (weight.proofSize - used.proofSize) };
      console.log(`  settle consumed about ${json(settle)} of its limit ${json(weightLimit)}`);
    }

    const poolAbi = (JSON.parse(readFileSync(`${BUILD_DIR}/Pool.json`, "utf8")) as { abi: Abi }).abi;
    const emitted = poolEvents(events, poolAbi, deployment.pool);
    for (const event of emitted) console.log(`  pool ${event.eventName} ${json(event.args)}`);

    const userSs58 = encodeAddress(user, 42);
    const feeAccountSs58 = encodeAddress(deployment.feeAccount, 42);
    const tokenTransfers = events.filter((e) => e.section === "foreignAssets" && e.method === "Transferred");
    const refunded = sum(
      events.filter((e) => e.section === "foreignAssets" && e.method === "Deposited" && e.fields.who === feeAccountSs58 && json(e.fields.assetId).includes('"x1"')),
      (e) => e.fields.amount,
    );
    const storageDeposit = sum(events.filter((e) => e.section === "balances" && e.method === "TransferAndHold"), (e) => e.fields.transferred);
    console.log(`  user ${userSs58} paid ${sum(tokenTransfers.filter((e) => e.fields.to === userSs58), (e) => e.fields.amount)}`);
    console.log(`  fee account ${feeAccountSs58} received ${sum(tokenTransfers.filter((e) => e.fields.to === feeAccountSs58), (e) => e.fields.amount)} token and ${refunded} wei of unspent execution fee`);
    console.log(`  execution fee spent ${executionFee - refunded} wei; storage deposit taken from the router account ${storageDeposit}`);

    const settled = emitted.some((event) => event.eventName === "Settled");
    if (values["drain-router"]) {
      if (!outcome.incomplete || settled) throw new Error("the drained router was expected to make the program Incomplete without a Settled event");
      console.log("  the program is Incomplete, as it must be when settle cannot run");
    } else if (!outcome.complete || !settled) {
      throw new Error("settle did not run: the program is not Complete with the pool's Settled event");
    }

    if (values["worst-path"]) {
      const none = await dryRunCall(api, routerAccount, deployment.pool, settleCalldata({ depositId: 990_010n, account: user, token: deployment.token, amount }));
      console.log(`settle with no tokens in the pool (user and fee account both owed): weight ${none.weight.refTime} / ${none.weight.proofSize}, storage deposit ${none.storageDeposit}, reverted ${none.reverted}`);
    }
  } finally {
    await api.disconnect();
  }
}

await main();
