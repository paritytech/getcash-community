import { readFileSync } from "node:fs";
import { u8aToHex } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import { encodeFunctionData, parseAbi, type Abi, type Address, type Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT, ETHEREUM_CHAIN_ID, XCM_PRECOMPILE, BUILD_DIR } from "./constants.js";
import { deliveredProgram, type BridgeMessage } from "./delivered.js";
import { readDeployment } from "./deployment.js";
import { dryRunFromBridgeHub, json, poolEvents } from "./effects.js";
import { accountLocation, ethereumAccountLocation, ethereumJunction, fallbackAccount } from "./location.js";
import { callView, dryRunCall } from "./revive.js";
import { depositAll, encodeVersionedXcm, reviveCall, routerProgram, settleCalldata, transactAsSovereign, type Instruction, type Weight } from "./xcm.js";

const SENDER_A: Address = "0x7e57000000000000000000000000000000000002";
const EXECUTION_FEE = 1_000_000_000_000n;

const deployment = readDeployment();
const poolAbi = (JSON.parse(readFileSync(`${BUILD_DIR}/Pool.json`, "utf8")) as { abi: Abi }).abi;
const api = await connect();
const user = u8aToHex(devKeyring("//Bob").publicKey);
const fresh = u8aToHex(devKeyring("//Fresh").publicKey);
const amount = 10n ** 18n;

function heading(text: string) {
  console.log(`\n${text}`);
}

async function runAs(sender: Address, userProgram: Instruction[], withToken: boolean) {
  const message: BridgeMessage = {
    router: sender,
    nonce: 1n,
    xcm: encodeVersionedXcm(api, userProgram),
    claimer: u8aToHex(api.createType("StagingXcmV5Location", accountLocation(user)).toU8a()),
    value: 0n,
    executionFee: EXECUTION_FEE,
    assets: withToken ? [{ token: deployment.token, amount }] : [],
  };
  return dryRunFromBridgeHub(api, encodeVersionedXcm(api, deliveredProgram(api, message)));
}

const settleCall = (account: Hex, weight: Weight = DEFAULT_SETTLE_WEIGHT) =>
  reviveCall(api, deployment.pool, settleCalldata({ depositId: 1n, account, token: deployment.token, amount }), weight, DEFAULT_STORAGE_DEPOSIT_LIMIT);

try {
  heading("1. another Ethereum sender aliasing into the router's location");
  const routerLocation = ethereumAccountLocation(ETHEREUM_CHAIN_ID, deployment.router);
  const attack = await runAs(SENDER_A, [{ AliasOrigin: routerLocation }, transactAsSovereign(settleCall(user))], true);
  console.log(`   AliasOrigin(router) as ${SENDER_A}: ${json(attack.outcome)}`);
  const childOfSender = { parents: 2, interior: { X3: [ethereumJunction(ETHEREUM_CHAIN_ID), { AccountKey20: { network: null, key: SENDER_A } }, { GeneralIndex: 7 }] } };
  const control = await runAs(SENDER_A, [{ AliasOrigin: childOfSender }], false);
  console.log(`   AliasOrigin(own child) as ${SENDER_A}: ${json(control.outcome)}`);
  const authorised = (await api.call.authorizedAliasersApi.isAuthorizedAlias({ V5: routerLocation }, { V5: ethereumAccountLocation(ETHEREUM_CHAIN_ID, SENDER_A) })).toJSON();
  console.log(`   isAuthorizedAlias(router <- ${SENDER_A}): ${json(authorised)}`);

  heading("2. a payout that fails, and a settle that cannot run");
  const program = (weight: Weight) => routerProgram(fallbackAccount(deployment.pool), deployment.feeAccount, settleCall(fresh, weight));
  const owed = await runAs(deployment.router, program(DEFAULT_SETTLE_WEIGHT), true);
  console.log(`   user without an account, normal limits: ${json(owed.outcome)}; pool events: ${poolEvents(owed.events, poolAbi, deployment.pool).map((e) => e.eventName).join(", ")}`);
  const starved = program({ refTime: 1_000_000n, proofSize: 1_000n });
  const guarded = await runAs(deployment.router, starved, true);
  console.log(`   weight limit too small for settle: ${json(guarded.outcome)}; pool events: ${poolEvents(guarded.events, poolAbi, deployment.pool).map((e) => e.eventName).join(", ") || "none"}`);
  console.log(`   trapped: ${guarded.events.filter((e) => e.method === "AssetsTrapped").map((e) => json(e.fields)).join(" ").slice(0, 300)}`);
  const unguarded = await runAs(deployment.router, starved.filter((i) => !JSON.stringify(i).includes("ExpectTransactStatus")), true);
  console.log(`   same without ExpectTransactStatus: ${json(unguarded.outcome)}; pool events: ${poolEvents(unguarded.events, poolAbi, deployment.pool).map((e) => e.eventName).join(", ") || "none"}`);

  heading("3. depositing the bridged token into an account that does not exist");
  for (const [name, beneficiary] of [["//Fresh", fresh], ["//Bob", user]] as const) {
    const result = await runAs(deployment.router, [depositAll(beneficiary)], true);
    console.log(`   DepositAsset to ${name}: ${json(result.outcome)}`);
  }

  heading("4. ERC-20 precompile of the bridged token");
  const erc20 = parseAbi(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
  const alice = u8aToHex(devKeyring("//Alice").publicKey);
  console.log(`   address ${deployment.tokenErc20}`);
  for (const functionName of ["totalSupply", "decimals", "symbol"] as const) {
    const result = await dryRunCall(api, alice, deployment.tokenErc20, encodeFunctionData({ abi: erc20, functionName }));
    console.log(`   ${functionName}: ${result.reverted ? "reverts" : "returns"} ${result.output}`);
  }
  console.log(`   balanceOf(pool): ${await callView(api, alice, deployment.tokenErc20, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [deployment.pool] }))}`);

  heading("5. XCM precompile");
  const xcmAbi = parseAbi(["function weighMessage(bytes message) view returns ((uint64 refTime, uint64 proofSize) weight)"]);
  const transfer = encodeVersionedXcm(api, [{ TransferAsset: { assets: [{ id: ethereumAccountLocation(ETHEREUM_CHAIN_ID, deployment.token), fun: { Fungible: amount } }], beneficiary: accountLocation(user) } }]);
  const weighed = await callView(api, alice, XCM_PRECOMPILE, encodeFunctionData({ abi: xcmAbi, functionName: "weighMessage", args: [transfer] }));
  console.log(`   weighMessage(TransferAsset): refTime ${BigInt(`0x${weighed.slice(2, 66)}`)}, proofSize ${BigInt(`0x${weighed.slice(66, 130)}`)}`);
  console.log(`   pool account ${encodeAddress(deployment.poolAccount, 42)} (${deployment.poolAccount})`);
} finally {
  await api.disconnect();
}
