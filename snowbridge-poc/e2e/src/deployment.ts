import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { DEPLOYMENT_FILE } from "./config";

export interface E2eDeployment {
  deployedAt: string;
  ethereumChainId: string;
  gateway: Address;
  token: Address;
  tokenErc20: Address;
  registry: Address;
  registryDeployBlock: string;
  registryDeployTx: Hex;
  factory: Address;
  router: Address;
  routerAccount: Hex;
  settler: Address;
  pool: Address;
  poolAccount: Hex;
  poolBlockHash: Hex;
  poolExtrinsicHash: Hex;
  admin: Address;
  trigger: Address;
  guardian: Address;
  payer: { ss58: string; account: Hex; h160: Address };
  feeAccount: { ss58: string; account: Hex };
  bridgeFee: string;
  frontFeeCapBps: number;
  executionFeeWei: string;
  payerPoolFunds: string;
  template: { xcmHead: Hex; xcmTail: Hex; claimerHead: Hex };
}

export function readDeployment(): E2eDeployment {
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as E2eDeployment;
}
