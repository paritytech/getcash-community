import { ethers, network } from "hardhat";
import { ARBITRUM_ONE, ARBITRUM_SEPOLIA, HOME_CHAIN, HOME_TOKEN } from "../config/chainflip";

// Deploys one SaleVault to the selected network. The operator and admin come from the environment
// so no key or address is baked into the tree. v1 is a plain deploy, and the resulting address is
// recorded by hand in the app lane config and the adapter config.
async function main() {
  const addrs =
    network.name === "arbitrumOne"
      ? ARBITRUM_ONE
      : network.name === "arbitrumSepolia"
        ? ARBITRUM_SEPOLIA
        : null;
  if (!addrs)
    throw new Error(
      `deploy: unsupported network "${network.name}" (use arbitrumOne or arbitrumSepolia)`,
    );

  const operator = process.env.OPERATOR_ADDRESS;
  const admin = process.env.ADMIN_ADDRESS;
  if (!operator || !admin) throw new Error("deploy: set OPERATOR_ADDRESS and ADMIN_ADDRESS");

  const factory = await ethers.getContractFactory("SaleVault");
  const vault = await factory.deploy(
    addrs.chainflipVault,
    addrs.usdc,
    HOME_CHAIN,
    HOME_TOKEN,
    operator,
    admin,
  );
  await vault.waitForDeployment();

  console.info(`SaleVault deployed to ${await vault.getAddress()} on ${network.name}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
