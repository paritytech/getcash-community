import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { DEPLOYMENT_FILE } from "./constants.js";

export interface Deployment {
  pool: Address;
  poolAccount: Hex;
  router: Address;
  settler: Address;
  feeAccount: Hex;
  token: Address;
  tokenErc20: Address;
  bridgeFee: string;
  frontFeeCapBps: number;
  ethereumChainId: string;
  deployer: string;
  blockHash: Hex;
  extrinsicHash: Hex;
}

export function readDeployment(): Deployment {
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
}
