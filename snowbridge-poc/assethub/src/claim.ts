import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ApiPromise } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import { decodeErrorResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { BUILD_DIR } from "./constants.js";
import { readDeployment } from "./deployment.js";
import { callView, dryRunCall, foreignBalance, signAndWait, submitCall } from "./revive.js";

const poolAbi = (JSON.parse(readFileSync(`${BUILD_DIR}/Pool.json`, "utf8")) as { abi: Abi }).abi;

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "//Owed1" },
    fund: { type: "boolean", default: false },
    "fund-amount": { type: "string", default: "10000000000" },
  },
});

async function owedTo(api: ApiPromise, caller: Hex, pool: Address, account: Hex, token: Address): Promise<bigint> {
  return BigInt(await callView(api, caller, pool, encodeFunctionData({ abi: poolAbi, functionName: "owed", args: [account, token] })));
}

function describeRevert(output: Hex): string {
  try {
    const decoded = decodeErrorResult({ abi: poolAbi, data: output });
    return `${decoded.errorName}${decoded.args?.length ? `: ${decoded.args.join(", ")}` : ""}`;
  } catch {
    return output;
  }
}

const deployment = readDeployment();
const api = await connect();
try {
  const caller = devKeyring("//Alice");
  const callerAccount = u8aToHex(caller.publicKey);
  const user = u8aToHex(devKeyring(values.user!).publicKey);
  const userSs58 = encodeAddress(user, 42);
  const data = encodeFunctionData({ abi: poolAbi, functionName: "claim", args: [user, deployment.token] });

  console.log(`user ${userSs58} is owed ${await owedTo(api, callerAccount, deployment.pool, user, deployment.token)}`);
  const before = await dryRunCall(api, callerAccount, deployment.pool, data);
  console.log(`claim by ${caller.address} before the account is funded: ${before.reverted ? `reverts (${describeRevert(before.output)})` : "would succeed"}`);

  if (values.fund) {
    const included = await signAndWait(api, api.tx.balances.transferKeepAlive(user, BigInt(values["fund-amount"]!)), caller);
    console.log(`funded ${userSs58} with ${values["fund-amount"]} planck in ${included.blockHash} (extrinsic ${included.extrinsicHash})`);
  }

  const tokenBefore = await foreignBalance(api, deployment.token, userSs58);
  const included = await submitCall(api, caller, deployment.pool, data);
  console.log(`claim in ${included.blockHash} (extrinsic ${included.extrinsicHash})`);
  console.log(`user token balance ${tokenBefore} -> ${await foreignBalance(api, deployment.token, userSs58)}; still owed ${await owedTo(api, callerAccount, deployment.pool, user, deployment.token)}`);
} finally {
  await api.disconnect();
}
