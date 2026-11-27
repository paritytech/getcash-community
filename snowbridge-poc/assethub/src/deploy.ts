import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { u8aToHex } from "@polkadot/util";
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { BUILD_DIR, CONTRACTS_JSON, DEPLOYMENT_FILE, ETHEREUM_CHAIN_ID } from "./constants.js";
import type { Deployment } from "./deployment.js";
import { ethereumSenderAccount, fallbackAccount, foreignAssetPrecompile, reviveAddress } from "./location.js";
import { publicClient } from "./ethereum.js";
import { assertPrecompileIsFor, callView, foreignAssetIndex, isMapped, signAndWait } from "./revive.js";

const TEST_ROUTER = "0x7e57000000000000000000000000000000000001";
const constructorAbi = parseAbiParameters(
  "address settler, uint16 frontFeeCapBps, uint256 bridgeFee, bytes32 feeAccount, address token, address tokenErc20, uint64 ethereumChainId",
);
const viewAbi = parseAbi(["function SETTLER() view returns (address)", "function TOKEN_ERC20() view returns (address)"]);

/** 0.001 of the token, read from the token's decimals on Ethereum. */
async function defaultBridgeFee(token: Address): Promise<bigint> {
  const decimals = await publicClient.readContract({ address: token, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  return 10n ** BigInt(Math.max(decimals - 3, 0));
}

async function main() {
  const { values } = parseArgs({
    options: {
      router: { type: "string", default: TEST_ROUTER },
      "fee-account": { type: "string" },
      token: { type: "string" },
      "token-erc20": { type: "string" },
      "bridge-fee": { type: "string" },
      "front-fee-cap-bps": { type: "string", default: "100" },
    },
  });
  const router = getAddress(values.router!);
  const token = getAddress(
    values.token ?? (JSON.parse(readFileSync(CONTRACTS_JSON, "utf8")) as { contracts: { Token: { address: string } } }).contracts.Token.address,
  );
  const api = await connect();
  try {
    const alice = devKeyring("//Alice");
    const aliceAccount = u8aToHex(alice.publicKey);
    if (!(await isMapped(api, aliceAccount))) await signAndWait(api, api.tx.revive.mapAccount(), alice);

    const settler = reviveAddress(ethereumSenderAccount(ETHEREUM_CHAIN_ID, router));
    const feeAccount = (values["fee-account"] ?? u8aToHex(devKeyring("//Charlie").publicKey)) as Hex;
    const tokenErc20 = values["token-erc20"] ? getAddress(values["token-erc20"]) : foreignAssetPrecompile(await foreignAssetIndex(api, token));
    await assertPrecompileIsFor(api, tokenErc20, token);
    const bridgeFee = values["bridge-fee"] ? BigInt(values["bridge-fee"]) : await defaultBridgeFee(token);
    const frontFeeCapBps = Number(values["front-fee-cap-bps"]);
    if (!Number.isInteger(frontFeeCapBps) || frontFeeCapBps < 0 || frontFeeCapBps > 10_000) throw new Error("front fee cap must be 0 to 10000 bps");

    const artifact = JSON.parse(readFileSync(`${BUILD_DIR}/Pool.json`, "utf8")) as { bytecode: Hex };
    const code = concat([
      artifact.bytecode,
      encodeAbiParameters(constructorAbi, [settler, frontFeeCapBps, bridgeFee, feeAccount, token, tokenErc20, ETHEREUM_CHAIN_ID]),
    ]);

    const dryRun = (await api.call.reviveApi.instantiate(aliceAccount, 0, null, null, { Upload: code }, "0x", null)).toJSON() as {
      weightRequired: { refTime: number; proofSize: number };
      maxStorageDeposit: { charge?: string | number };
      result: { ok?: { addr: Address }; err?: unknown };
    };
    if (!dryRun.result.ok) throw new Error(`instantiate would fail: ${JSON.stringify(dryRun.result.err)}`);
    const weight = {
      refTime: (BigInt(dryRun.weightRequired.refTime) * 13n) / 10n,
      proofSize: (BigInt(dryRun.weightRequired.proofSize) * 13n) / 10n,
    };
    const depositLimit = (BigInt(dryRun.maxStorageDeposit.charge ?? 0) * 13n) / 10n + 1_000_000_000n;

    const included = await signAndWait(api, api.tx.revive.instantiateWithCode(0, weight, depositLimit, code, "0x", null), alice);
    const instantiated = included.events.find(({ event }) => api.events.revive.Instantiated.is(event));
    const pool = getAddress((instantiated?.event.data as unknown as { contract: { toHex(): Hex } }).contract.toHex());
    if (pool !== getAddress(dryRun.result.ok.addr)) throw new Error("deployed address differs from the dry-run address");

    const onChainSettler = await callView(api, aliceAccount, pool, encodeFunctionData({ abi: viewAbi, functionName: "SETTLER" }));
    const onChainErc20 = await callView(api, aliceAccount, pool, encodeFunctionData({ abi: viewAbi, functionName: "TOKEN_ERC20" }));
    if (getAddress(`0x${onChainSettler.slice(26)}`) !== settler || getAddress(`0x${onChainErc20.slice(26)}`) !== tokenErc20) {
      throw new Error("deployed contract reports other constructor arguments");
    }

    const deployment: Deployment = {
      pool,
      poolAccount: fallbackAccount(pool),
      router,
      settler,
      feeAccount,
      token,
      tokenErc20,
      bridgeFee: bridgeFee.toString(),
      frontFeeCapBps,
      ethereumChainId: ETHEREUM_CHAIN_ID.toString(),
      deployer: alice.address,
      blockHash: included.blockHash,
      extrinsicHash: included.extrinsicHash,
    };
    mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
    writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(JSON.stringify(deployment, null, 2));
  } finally {
    await api.disconnect();
  }
}

await main();
