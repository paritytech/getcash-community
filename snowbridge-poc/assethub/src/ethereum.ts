import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { CONTRACTS_JSON, ETHEREUM_CHAIN_ID, SNOWBRIDGE_DIR } from "./constants.js";

const SET_ENV = resolve(SNOWBRIDGE_DIR, "web/packages/test/scripts/set-env.sh");

const chain = defineChain({
  id: Number(ETHEREUM_CHAIN_ID),
  name: "local-ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const publicClient = createPublicClient({ chain, transport: http() });

/** The local deployer key from the stack's env script; it never leaves this process. */
export function deployerClient() {
  const match = /export PRIVATE_KEY="\$\{DEPLOYER_ETH_KEY:-(0x[0-9a-fA-F]{64})\}"/.exec(readFileSync(SET_ENV, "utf8"));
  if (!match) throw new Error("deployer key not found in set-env.sh");
  const account = privateKeyToAccount(match[1] as Hex);
  return { account, wallet: createWalletClient({ chain, account, transport: http() }) };
}

export function snowbridgeContracts(): { gateway: Address; token: Address } {
  const { contracts } = JSON.parse(readFileSync(CONTRACTS_JSON, "utf8")) as { contracts: Record<string, { address: Address }> };
  return { gateway: contracts.GatewayProxy!.address, token: contracts.Token!.address };
}
