import { readFileSync } from "node:fs";
import type { ApiPromise } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import { u8aToHex } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Address, type Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { BUILD_DIR, DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT } from "./constants.js";
import { deliveredProgram } from "./delivered.js";
import { readDeployment, type Deployment } from "./deployment.js";
import { dryRunFromBridgeHub, json, poolEvents } from "./effects.js";
import { assembleClaimer, assembleXcm, buildTemplate } from "./template.js";
import { encodeVersionedXcm } from "./xcm.js";
import { reviveAddress } from "./location.js";
import { callView, foreignBalance, submitCall } from "./revive.js";

const poolAbi = (JSON.parse(readFileSync(`${BUILD_DIR}/Pool.json`, "utf8")) as { abi: Abi }).abi;
const erc20Abi = parseAbi(["function approve(address spender, uint256 value) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const FRONTED = 10n ** 20n;
const DEPOSIT_ID = 77n;

async function callContract(api: ApiPromise, signer: KeyringPair, dest: Address, data: Hex): Promise<void> {
  const included = await submitCall(api, signer, dest, data);
  console.log(`  ${dest} in ${included.blockHash}, extrinsic ${included.extrinsicHash}`);
}

const balance = foreignBalance;

async function dryRunSettle(api: ApiPromise, d: Deployment, account: Hex, amount: bigint) {
  const template = await buildTemplate(api, { pool: d.pool, feeAccount: d.feeAccount, weightLimit: DEFAULT_SETTLE_WEIGHT, storageDepositLimit: DEFAULT_STORAGE_DEPOSIT_LIMIT });
  const message = {
    router: d.router,
    nonce: 2002n,
    xcm: assembleXcm(template, { depositId: DEPOSIT_ID, account, token: d.token, amount }),
    claimer: assembleClaimer(template, account),
    value: 0n,
    executionFee: 600_000_000_000n,
    assets: [{ token: d.token, amount }],
  };
  const { outcome, events } = await dryRunFromBridgeHub(api, encodeVersionedXcm(api, deliveredProgram(api, message)));
  console.log(`  outcome ${json(outcome)}`);
  for (const event of poolEvents(events, poolAbi, d.pool)) console.log(`  pool ${event.eventName} ${json(event.args)}`);
}

const d = readDeployment();
const api = await connect();
try {
  const payer = devKeyring("//Alice");
  const payerAccount = u8aToHex(payer.publicKey);
  const user = u8aToHex(devKeyring("//Bob").publicKey);
  const bridgeFee = BigInt(d.bridgeFee);
  const fee = bridgeFee + FRONTED / 1000n;
  const funding = FRONTED * 2n;

  console.log(`payer ${payer.address} (${reviveAddress(payerAccount)}) holds ${await balance(api, d.token, payer.address)} of the token`);
  console.log("approve the pool on the ERC-20 precompile, then addFunds");
  await callContract(api, payer, d.tokenErc20, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.pool, funding] }));
  await callContract(api, payer, d.pool, encodeFunctionData({ abi: poolAbi, functionName: "addFunds", args: [d.token, funding] }));
  console.log(`  pool holds ${await balance(api, d.token, encodeAddress(d.poolAccount, 42))}`);

  const userBefore = await balance(api, d.token, encodeAddress(user, 42));
  console.log(`front deposit ${DEPOSIT_ID} for ${encodeAddress(user, 42)}: ${FRONTED} minus fee ${fee}`);
  await callContract(api, payer, d.pool, encodeFunctionData({ abi: poolAbi, functionName: "front", args: [DEPOSIT_ID, user, d.token, FRONTED, fee] }));
  console.log(`  user received ${(await balance(api, d.token, encodeAddress(user, 42))) - userBefore}`);
  const stateData = encodeFunctionData({ abi: poolAbi, functionName: "state", args: [DEPOSIT_ID, user, d.token, FRONTED] });
  const [status, payerOnChain] = decodeFunctionResult({ abi: poolAbi, functionName: "state", data: await callView(api, payerAccount, d.pool, stateData) }) as [number, Address];
  console.log(`  state(${DEPOSIT_ID}) is ${status} (1 = fronted) by ${payerOnChain}`);

  console.log("settle as the router delivers it, matching the front");
  await dryRunSettle(api, d, user, FRONTED);
  console.log("settle with another amount than fronted");
  await dryRunSettle(api, d, user, FRONTED + 1n);

  console.log("removeFunds of what is left");
  const left = funding - (FRONTED - fee);
  await callContract(api, payer, d.pool, encodeFunctionData({ abi: poolAbi, functionName: "removeFunds", args: [d.token, left] }));
  console.log(`  payer holds ${await balance(api, d.token, payer.address)}, pool holds ${await balance(api, d.token, encodeAddress(d.poolAccount, 42))}`);
} finally {
  await api.disconnect();
}
