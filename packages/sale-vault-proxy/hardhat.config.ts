import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import "dotenv/config";
import type { HardhatUserConfig } from "hardhat/config";
import { ARBITRUM_ONE, ARBITRUM_SEPOLIA } from "./config/networks";

// Secrets come from the environment, `||` lets an empty .env.example value fall back to the public RPC
const ARBITRUM_ONE_RPC = process.env.ARBITRUM_ONE_RPC || "https://arb1.arbitrum.io/rpc";
const ARBITRUM_SEPOLIA_RPC =
  process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY ?? "";
// Only "1" forks, so ARBITRUM_FORK=0 or an empty value does not
const FORK = process.env.ARBITRUM_FORK === "1";
// A block to pin the Arbitrum One fork test to. Unset means the live tip.
const FORK_BLOCK = process.env.ARBITRUM_FORK_BLOCK
  ? Number(process.env.ARBITRUM_FORK_BLOCK)
  : undefined;

const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Not needed for stack depth, it trims about 1 KB of bytecode per contract
      viaIR: true,
      // Pinned so a toolchain upgrade cannot change the bytecode or its verification
      evmVersion: "paris",
    },
  },
  networks: {
    // The in-process node, `test:fork` and `vectors` set ARBITRUM_FORK=1 to fork Arbitrum One
    hardhat: FORK
      ? { forking: { url: ARBITRUM_ONE_RPC, ...(FORK_BLOCK ? { blockNumber: FORK_BLOCK } : {}) } }
      : {},
    // Hardhat refuses an RPC whose chain id differs, so a wrong RPC override cannot deploy elsewhere
    arbitrumOne: { url: ARBITRUM_ONE_RPC, chainId: ARBITRUM_ONE.chainId, accounts },
    arbitrumSepolia: { url: ARBITRUM_SEPOLIA_RPC, chainId: ARBITRUM_SEPOLIA.chainId, accounts },
  },
  // Etherscan v2 unified key (one key routes by chainId across chains).
  etherscan: {
    apiKey: ARBISCAN_API_KEY,
  },
};

export default config;
