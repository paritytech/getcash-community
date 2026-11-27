import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, getAddress, getContractAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import { connect, devKeyring } from "../../assethub/src/chain";
import { ETHEREUM_CHAIN_ID } from "../../assethub/src/constants";
import type { Deployment as PoolDeployment } from "../../assethub/src/deployment";
import { deployerClient, snowbridgeContracts } from "../../assethub/src/ethereum";
import { quoteDelivery } from "../../assethub/src/fees";
import { ethereumSenderAccount, reviveAddress } from "../../assethub/src/location";
import { submitCall } from "../../assethub/src/revive";
import { assembleClaimer, assembleXcm, type Template } from "../../assethub/src/template";
import { chain, publicClient, sendEth, walletFor } from "./chains";
import {
  ASSETHUB_DEPLOYMENT_FILE,
  ASSETHUB_DIR,
  ASSET_HUB_WS,
  DEFAULTS,
  DEPLOYMENT_FILE,
  ETHEREUM_RPC,
  ETH_DIR,
  POOL_ARTIFACT,
} from "./config";
import type { E2eDeployment } from "./deployment";
import { generateKeys, identities, writeKeys } from "./keys";
import { checkPoolImmutables } from "./poolCheck";
import { signWithRetry } from "./substrate";
import { fundTestOnAssetHub } from "./testToken";

const factoryAbi = parseAbi(["function ROUTER() view returns (address)", "function REGISTRY() view returns (address)"]);
const registryAbi = parseAbi(["function relayer() view returns (address)", "function guardian() view returns (address)", "function admin() view returns (address)", "event RelayerChanged(address relayer)"]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);

const step = (text: string) => console.log(`\n== ${text}`);
const hex32 = (hex: Hex) => hex.toLowerCase() as Hex;

// Runs a child process with its output captured; the command line is never echoed because it may carry a key.
function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  const result = spawnSync(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-25).join("\n");
    throw new Error(`${command} ${args[0] ?? ""} failed with status ${result.status}\n${tail}`);
  }
  return result.stdout;
}

// The assethub tools sign with //Alice, which other users of the stack also use; a lost nonce shows as a rejected extrinsic.
function pnpmAssetHub(...args: string[]): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return run("pnpm", ["--dir", ASSETHUB_DIR, "run", ...args]);
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error && error.message.includes("extrinsic rejected"))) throw error;
      console.log(`  //Alice's transaction was rejected, trying again (${attempt})`);
    }
  }
}

async function main() {
  const forceBridge = process.env.FORCE_BRIDGE_TEST === "1";
  const bridgeFee = BigInt(process.env.BRIDGE_FEE ?? DEFAULTS.bridgeFee);
  const frontFeeCapBps = Number(process.env.FRONT_FEE_CAP_BPS ?? DEFAULTS.frontFeeCapBps);
  const payerPoolFunds = BigInt(process.env.PAYER_POOL_FUNDS ?? DEFAULTS.payerPoolFunds);

  if (existsSync(DEPLOYMENT_FILE)) rmSync(DEPLOYMENT_FILE);
  const { gateway, token } = snowbridgeContracts();
  const deployer = deployerClient();
  const api = await connect(ASSET_HUB_WS);
  try {
    if ((await publicClient.getChainId()) !== Number(ETHEREUM_CHAIN_ID)) throw new Error("the Ethereum node has another chain id than the stack's");
    if (((await publicClient.getCode({ address: gateway })) ?? "0x") === "0x") throw new Error(`no contract at the Gateway ${gateway}`);

    step("fresh keys");
    const keys = generateKeys();
    const keyBackup = writeKeys(keys);
    if (keyBackup) console.log(`  the previous keys are kept in ${keyBackup}`);
    const who = identities(keys);
    const alice = devKeyring("//Alice");
    console.log(`  trigger ${who.trigger.address}, guardian ${who.guardian.address}, admin ${who.admin.address}`);
    console.log(`  payer ${who.payer.ss58}, fee account ${who.feeAccount.ss58}`);

    step("fund the new keys");
    for (const [name, to, value] of [
      ["admin", who.admin.address, DEFAULTS.ethFunding.admin],
      ["trigger", who.trigger.address, DEFAULTS.ethFunding.trigger],
      ["guardian", who.guardian.address, DEFAULTS.ethFunding.guardian],
    ] as const) {
      console.log(`  ${name} ${value} wei, tx ${await sendEth(deployer.wallet, to, value)}`);
    }
    for (const [name, to, value] of [
      ["payer", who.payer.ss58, DEFAULTS.wndFunding.payer],
      ["fee account", who.feeAccount.ss58, DEFAULTS.wndFunding.feeAccount],
    ] as const) {
      const included = await signWithRetry(api, () => api.tx.balances.transferKeepAlive(to, value), alice);
      console.log(`  ${name} ${value} planck, block ${included.blockHash}`);
    }

    step("predict the router");
    if ((await publicClient.getTransactionCount({ address: who.admin.address })) !== 0) throw new Error("the admin key is not fresh");
    const predictedFactory = getContractAddress({ from: who.admin.address, nonce: 1n });
    const predictedRouter = getContractAddress({ from: predictedFactory, nonce: 1n });
    const routerAccount = ethereumSenderAccount(ETHEREUM_CHAIN_ID, predictedRouter);
    const settler = reviveAddress(routerAccount);
    console.log(`  factory ${predictedFactory}, router ${predictedRouter}`);
    console.log(`  router account ${routerAccount}, address on Asset Hub ${settler}`);

    step("fund the router's Asset Hub account");
    const funded = await signWithRetry(api, () => api.tx.balances.transferKeepAlive(routerAccount, DEFAULTS.wndFunding.router), alice);
    console.log(`  ${DEFAULTS.wndFunding.router} planck, block ${funded.blockHash}`);

    step("deploy the pool on Asset Hub");
    pnpmAssetHub("deploy", "--router", predictedRouter, "--fee-account", who.feeAccount.account, "--bridge-fee", bridgeFee.toString(), "--front-fee-cap-bps", String(frontFeeCapBps));
    const pool = JSON.parse(readFileSync(ASSETHUB_DEPLOYMENT_FILE, "utf8")) as PoolDeployment;
    if (getAddress(pool.router) !== predictedRouter || getAddress(pool.settler) !== settler) throw new Error("the pool was deployed for another router");
    console.log(`  pool ${pool.pool}, settler ${pool.settler}, block ${pool.blockHash}`);

    step("generate the template");
    const templateFile = join(dirname(DEPLOYMENT_FILE), "template.json");
    mkdirSync(dirname(templateFile), { recursive: true });
    pnpmAssetHub("template", "--pool", pool.pool, "--fee-account", who.feeAccount.account, "--out", templateFile);
    const template = JSON.parse(readFileSync(templateFile, "utf8")) as Template;
    rmSync(templateFile);
    console.log(`  xcmHead ${(template.xcmHead.length - 2) / 2} bytes, xcmTail ${(template.xcmTail.length - 2) / 2} bytes, claimerHead ${(template.claimerHead.length - 2) / 2} bytes`);

    step("deploy the registry and the factory");
    const broadcastFile = join(ETH_DIR, "broadcast/Deploy.s.sol", String(chain.id), "run-latest.json");
    run(
      "forge",
      // The local geth's miner ignores a tip below 0.001 gwei, which is what forge picks on a chain with no recent traffic. This puts the admin key in ps: acceptable for a local dev key, not for a production one.
      ["script", "script/Deploy.s.sol", "--root", ETH_DIR, "--rpc-url", ETHEREUM_RPC, "--broadcast", "--slow", "--with-gas-price", "2000000000", "--priority-gas-price", "1000000000", "--private-key", keys.adminKey],
      {
        cwd: ETH_DIR,
        env: {
          GATEWAY: gateway,
          TOKEN: token,
          ADMIN: who.admin.address,
          RELAYER: who.trigger.address,
          GUARDIAN: who.guardian.address,
          XCM_HEAD: template.xcmHead,
          XCM_TAIL: template.xcmTail,
          CLAIMER_HEAD: template.claimerHead,
        },
      },
    );
    const broadcast = JSON.parse(readFileSync(broadcastFile, "utf8")) as {
      transactions: { hash: Hex; contractName: string | null; contractAddress: Address | null }[];
      receipts: { transactionHash: Hex; blockNumber: Hex; status: Hex }[];
    };
    const created = (name: string) => {
      const found = broadcast.transactions.find((tx) => tx.contractName === name && tx.contractAddress);
      if (!found) throw new Error(`the broadcast has no ${name} deployment`);
      return { address: getAddress(found.contractAddress!), hash: found.hash };
    };
    const registry = created("Registry");
    const factory = created("ForwarderFactory");
    const registryReceipt = broadcast.receipts.find((receipt) => receipt.transactionHash === registry.hash);
    if (!registryReceipt || registryReceipt.status !== "0x1") throw new Error("the registry deployment has no successful receipt");
    const registryDeployBlock = BigInt(registryReceipt.blockNumber);
    console.log(`  registry ${registry.address} in block ${registryDeployBlock}, factory ${factory.address}`);

    step("check the deployment");
    const router = getAddress(await publicClient.readContract({ address: factory.address, abi: factoryAbi, functionName: "ROUTER" }));
    if (factory.address !== predictedFactory) throw new Error(`factory ${factory.address} differs from the prediction ${predictedFactory}`);
    if (router !== predictedRouter) throw new Error(`factory.ROUTER() ${router} differs from the prediction ${predictedRouter}`);
    const [relayer, guardian, admin] = await Promise.all(
      (["relayer", "guardian", "admin"] as const).map((functionName) => publicClient.readContract({ address: registry.address, abi: registryAbi, functionName })),
    );
    if (relayer !== who.trigger.address || guardian !== who.guardian.address || admin !== who.admin.address) throw new Error("the registry holds other keys than the new ones");
    const changed = await publicClient.getLogs({ address: registry.address, event: registryAbi[3], fromBlock: registryDeployBlock, toBlock: registryDeployBlock });
    if (changed.length !== 1) throw new Error("the registry's RelayerChanged is not in the recorded deploy block");
    console.log(`  factory.ROUTER() equals the prediction ${router}; registry keys match`);
    const immutables = await checkPoolImmutables(api, who.payer.account, pool.pool, {
      settler,
      token,
      tokenErc20: pool.tokenErc20,
      feeAccount: who.feeAccount.account,
      bridgeFee,
      frontFeeCapBps,
      ethereumChainId: ETHEREUM_CHAIN_ID,
    });
    console.log(`  the pool's immutables on chain match the deployment: ${immutables.join(", ")}`);

    step("quote the execution fee");
    const probeAmount = 10n ** 18n;
    const quote = await quoteDelivery(api, {
      router,
      nonce: 0n,
      xcm: assembleXcm(template, { depositId: 1n, account: who.payer.account, token, amount: probeAmount }),
      claimer: assembleClaimer(template, who.payer.account),
      value: 0n,
      executionFee: 1n,
      assets: [{ token, amount: probeAmount }],
    });
    const executionFee = (quote.fee * DEFAULTS.executionFeeMarginPercent) / 100n;
    console.log(`  quoted ${quote.fee} wei, with margin ${executionFee} wei`);

    step("put TEST into the pool for the payer");
    const poolAbi = (JSON.parse(readFileSync(POOL_ARTIFACT, "utf8")) as { abi: Abi }).abi;
    await fundTestOnAssetHub(api, token, who.payer.ss58, payerPoolFunds, forceBridge);
    const approved = await submitCall(api, who.payer.pair, pool.tokenErc20, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool.pool, payerPoolFunds] }));
    const added = await submitCall(api, who.payer.pair, pool.pool, encodeFunctionData({ abi: poolAbi, functionName: "addFunds", args: [token, payerPoolFunds] }));
    console.log(`  approve ${approved.extrinsicHash}, addFunds ${added.extrinsicHash} (block ${added.blockHash})`);

    step("write the deployment");
    const deployment: E2eDeployment = {
      deployedAt: new Date().toISOString(),
      ethereumChainId: ETHEREUM_CHAIN_ID.toString(),
      gateway,
      token,
      tokenErc20: pool.tokenErc20,
      registry: registry.address,
      registryDeployBlock: registryDeployBlock.toString(),
      registryDeployTx: registry.hash,
      factory: factory.address,
      router,
      routerAccount: hex32(routerAccount),
      settler,
      pool: pool.pool,
      poolAccount: pool.poolAccount,
      poolBlockHash: pool.blockHash,
      poolExtrinsicHash: pool.extrinsicHash,
      admin: who.admin.address,
      trigger: who.trigger.address,
      guardian: who.guardian.address,
      payer: { ss58: who.payer.ss58, account: who.payer.account, h160: reviveAddress(who.payer.account) },
      feeAccount: { ss58: who.feeAccount.ss58, account: who.feeAccount.account },
      bridgeFee: pool.bridgeFee,
      frontFeeCapBps: pool.frontFeeCapBps,
      executionFeeWei: executionFee.toString(),
      payerPoolFunds: payerPoolFunds.toString(),
      template,
    };
    mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
    writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`  wrote ${DEPLOYMENT_FILE}`);
    console.log(`\nregistry ${deployment.registry} (deploy block ${deployment.registryDeployBlock})\nfactory  ${deployment.factory}\nrouter   ${deployment.router}\npool     ${deployment.pool}`);
  } finally {
    await api.disconnect();
  }
}

await main();
