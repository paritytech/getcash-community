import { ethers, network, run } from "hardhat";
import { liveProblems } from "../config/chainflip";
import {
  ARBITRUM_ONE,
  ARBITRUM_SEPOLIA,
  adapterSaleVaultProxy,
  factoryConfig,
} from "../config/networks";
import { predictProxy } from "../test/helpers";
import vectors from "../vectors.json";

// Deploys one SaleVaultProxyFactory, which creates its SaleVaultProxy implementation, then checks every getter
async function main() {
  const net =
    network.name === "arbitrumOne"
      ? ARBITRUM_ONE
      : network.name === "arbitrumSepolia"
        ? ARBITRUM_SEPOLIA
        : null;
  if (!net)
    throw new Error(
      `deploy: unsupported network "${network.name}" (use arbitrumOne or arbitrumSepolia)`,
    );
  const treasury = process.env.TREASURY_ADDRESS;
  if (!treasury || !ethers.isAddress(treasury)) throw new Error("deploy: set TREASURY_ADDRESS");
  const guardianEnv = process.env.GUARDIAN_ADDRESS;
  if (!guardianEnv || !ethers.isAddress(guardianEnv))
    throw new Error("deploy: set GUARDIAN_ADDRESS");
  const guardian = ethers.getAddress(guardianEnv);
  // The guardian is its own key, never the one that deploys or operates
  const [deployer] = await ethers.getSigners();
  if (guardian === deployer.address)
    throw new Error("deploy: GUARDIAN_ADDRESS is the deployer key");

  // The token is the chain's USDC and the Chainflip Vault holds it
  const usdc = new ethers.Contract(
    net.usdc,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
    ],
    ethers.provider,
  );
  if ((await usdc.symbol()) !== "USDC" || (await usdc.decimals()) !== 6n)
    throw new Error(`deploy: ${net.usdc} is not a 6-decimal USDC`);
  if ((await usdc.balanceOf(net.vault)) === 0n)
    throw new Error(`deploy: the Chainflip Vault holds no ${net.usdc}`);

  const problems = await liveProblems(net);
  if (problems.length)
    throw new Error(`deploy: config fails live Chainflip: ${problems.join(", ")}`);

  const config = factoryConfig(net, ethers.getAddress(treasury), guardian);
  const factory = await (await ethers.getContractFactory("SaleVaultProxyFactory")).deploy(config);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const implementationAddress = await factory.IMPLEMENTATION();
  const impl = await ethers.getContractAt("SaleVaultProxy", implementationAddress);

  const checks: [string, unknown, unknown][] = [
    ["VAULT", await factory.VAULT(), ethers.getAddress(net.vault)],
    ["USDC", await factory.USDC(), ethers.getAddress(net.usdc)],
    ["TREASURY", await factory.TREASURY(), config.treasury],
    ["GUARDIAN", await factory.GUARDIAN(), guardian],
    ["retired", await factory.retired(), false],
    ["implementation TREASURY", await impl.TREASURY(), config.treasury],
    ["implementation VAULT", await impl.VAULT(), ethers.getAddress(net.vault)],
    ["implementation USDC", await impl.USDC(), ethers.getAddress(net.usdc)],
    ["FACTORY", await impl.FACTORY(), factoryAddress],
    ["BROKER", await impl.BROKER(), net.broker],
    ["RETRY_BLOCKS", await impl.RETRY_BLOCKS(), BigInt(net.retryBlocks)],
    ["MIN_RETURN", await impl.MIN_RETURN(), net.minReturn],
    ["MAX_RETURN", await impl.MAX_RETURN(), net.maxReturn],
    ["PRICE_FLOOR_BPS", await impl.PRICE_FLOOR_BPS(), net.priceFloorBps],
    ["FEE_ALLOWANCE", await impl.FEE_ALLOWANCE(), net.feeAllowance],
    ["RETURN_COOLDOWN", await impl.RETURN_COOLDOWN(), net.returnCooldown],
    ["RELEASE_DELAY", await impl.RELEASE_DELAY(), net.releaseDelay],
    ["RELEASE_ATTEMPTS", await impl.RELEASE_ATTEMPTS(), net.releaseAttempts],
    ["STALE_DELAY", await impl.STALE_DELAY(), net.staleDelay],
    ["HOME_CHAIN", await impl.HOME_CHAIN(), BigInt(net.homeChain)],
    ["HOME_TOKEN", await impl.HOME_TOKEN(), BigInt(net.homeToken)],
  ];
  const { home: probe, claimer: probeClaimer } = vectors.predict.pinned[0];
  checks.push([
    "predict",
    await factory.predict(probe, probeClaimer),
    predictProxy(factoryAddress, implementationAddress, probe, probeClaimer),
  ]);
  for (const [name, got, want] of checks) {
    if (got !== want)
      throw new Error(`deploy: ${name} is ${String(got)}, expected ${String(want)}`);
  }

  console.info(`chainId ${net.chainId}`);
  console.info(`SaleVaultProxyFactory ${factoryAddress}`);
  console.info(`SaleVaultProxy implementation ${implementationAddress}`);
  console.info("\nAdapter sale_vault_proxy fields, add rpc_url and keeper_key yourself:");
  console.info(JSON.stringify(adapterSaleVaultProxy(net, factoryAddress), null, 2));
  console.info(
    `\nBuild env:\nVITE_SALE_VAULT_PROXY_FACTORY=${factoryAddress}\nVITE_SALE_VAULT_PROXY_IMPLEMENTATION=${implementationAddress}`,
  );

  // Etherscan v2 verification, the implementation is created by the factory's constructor
  const targets: [string, unknown[]][] = [
    [factoryAddress, [config]],
    [implementationAddress, [factoryAddress, config]],
  ];
  for (const [address, constructorArguments] of targets) {
    try {
      await run("verify:verify", { address, constructorArguments });
    } catch (error) {
      console.warn(`verify ${address} failed, rerun hardhat verify by hand:`, error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
