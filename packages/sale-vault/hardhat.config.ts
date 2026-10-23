import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import "dotenv/config";
import type { HardhatUserConfig } from "hardhat/config";

// Everything secret comes from the environment, never the tree. See .env.example.
const ARBITRUM_ONE_RPC = process.env.ARBITRUM_ONE_RPC ?? "https://arb1.arbitrum.io/rpc";
const ARBITRUM_SEPOLIA_RPC =
  process.env.ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY ?? "";
// A block to pin the Arbitrum One fork test to. Unset means the live tip.
const FORK_BLOCK = process.env.ARBITRUM_FORK_BLOCK
  ? Number(process.env.ARBITRUM_FORK_BLOCK)
  : undefined;

const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

// Solidity 0.8.28 with viaIR, matching the Polkadot-ecosystem house setting
// (create-polkadot-dapp, p2p-market). The contract targets Arbitrum, a standard EVM L2, so this is
// plain solc EVM output with no resolc/PVM lane.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    // The in-process node. `test:fork` sets ARBITRUM_FORK to fork Arbitrum One for the fork suite.
    hardhat: process.env.ARBITRUM_FORK
      ? { forking: { url: ARBITRUM_ONE_RPC, ...(FORK_BLOCK ? { blockNumber: FORK_BLOCK } : {}) } }
      : {},
    arbitrumOne: { url: ARBITRUM_ONE_RPC, chainId: 42161, accounts },
    arbitrumSepolia: { url: ARBITRUM_SEPOLIA_RPC, chainId: 421614, accounts },
  },
  // Etherscan v2 unified key (one key routes by chainId across chains).
  etherscan: {
    apiKey: ARBISCAN_API_KEY,
  },
  contractSizer: { runOnCompile: false },
};

export default config;
