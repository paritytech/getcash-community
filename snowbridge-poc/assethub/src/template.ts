import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ApiPromise } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { bytesToHex, concat, hexToBytes, size, toFunctionSelector, type Address, type Hex } from "viem";
import { connect, devKeyring } from "./chain.js";
import { DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT } from "./constants.js";
import { readDeployment } from "./deployment.js";
import { accountLocation, fallbackAccount, type NetworkId } from "./location.js";
import { signedOriginNetwork } from "./network.js";
import {
  encodeVersionedXcm,
  reviveCall,
  routerProgram,
  settleArgsEncoding,
  settleAbi,
  SETTLE_CALLDATA_LENGTH,
  type SettleArgs,
  type Weight,
} from "./xcm.js";

export interface TemplateInput {
  pool: Address;
  feeAccount: Hex;
  weightLimit: Weight;
  storageDepositLimit: bigint;
  /** The network the claimer names; by default the one a signed claim carries on the connected chain. */
  claimerNetwork?: NetworkId | null;
}

export interface Template {
  xcmHead: Hex;
  xcmTail: Hex;
  claimerHead: Hex;
}

const SETTLE_ARGS_LENGTH = 128;
const ARGS_PLACEHOLDER = `0x${"ab".repeat(SETTLE_ARGS_LENGTH)}` as Hex;
const ACCOUNT_PLACEHOLDER = `0x${"cd".repeat(32)}` as Hex;

function indexOfUnique(haystack: Uint8Array, needle: Uint8Array): number {
  const found: number[] = [];
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((b, j) => haystack[i + j] === b)) found.push(i);
  }
  if (found.length !== 1) throw new Error(`placeholder occurs ${found.length} times`);
  return found[0]!;
}

function splitAround(encoded: Hex, placeholder: Hex): [Hex, Hex] {
  const bytes = hexToBytes(encoded);
  const at = indexOfUnique(bytes, hexToBytes(placeholder));
  return [bytesToHex(bytes.subarray(0, at)), bytesToHex(bytes.subarray(at + size(placeholder)))];
}

export async function buildTemplate(api: ApiPromise, input: TemplateInput): Promise<Template> {
  const calldata = concat([toFunctionSelector(settleAbi[0]), ARGS_PLACEHOLDER]);
  if (size(calldata) !== SETTLE_CALLDATA_LENGTH) throw new Error("settle calldata is not 132 bytes");

  const call = reviveCall(api, input.pool, calldata, input.weightLimit, input.storageDepositLimit);
  const program = encodeVersionedXcm(api, routerProgram(fallbackAccount(input.pool), input.feeAccount, call));
  const [xcmHead, xcmTail] = splitAround(program, ARGS_PLACEHOLDER);

  const claimerNetwork = input.claimerNetwork === undefined ? await signedOriginNetwork(api) : input.claimerNetwork;
  const claimer = api.createType("StagingXcmV5Location", accountLocation(ACCOUNT_PLACEHOLDER, claimerNetwork));
  const [claimerHead, claimerTail] = splitAround(u8aToHex(claimer.toU8a()), ACCOUNT_PLACEHOLDER);
  if (size(claimerTail) !== 0) throw new Error("claimer does not end with the account");

  return { xcmHead, xcmTail, claimerHead };
}

/** The `xcm` bytes the router hands to the Gateway for one deposit. */
export function assembleXcm(template: Template, args: SettleArgs): Hex {
  return concat([template.xcmHead, settleArgsEncoding(args), template.xcmTail]);
}

/** The `claimer` bytes the router hands to the Gateway for one deposit. */
export function assembleClaimer(template: Template, account: Hex): Hex {
  return concat([template.claimerHead, account]);
}

function parseNetwork(value: string | undefined): NetworkId | null | undefined {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  if (value === "polkadot") return { Polkadot: null };
  if (value === "kusama") return { Kusama: null };
  return { ByGenesis: value as Hex };
}

async function main() {
  const { values } = parseArgs({
    options: {
      pool: { type: "string" },
      "fee-account": { type: "string" },
      "weight-ref-time": { type: "string", default: DEFAULT_SETTLE_WEIGHT.refTime.toString() },
      "weight-proof-size": { type: "string", default: DEFAULT_SETTLE_WEIGHT.proofSize.toString() },
      "storage-deposit-limit": { type: "string", default: DEFAULT_STORAGE_DEPOSIT_LIMIT.toString() },
      "claimer-network": { type: "string" },
      out: { type: "string" },
    },
  });
  const deployment = readDeployment();
  const api = await connect();
  try {
    const template = await buildTemplate(api, {
      pool: (values.pool ?? deployment.pool) as Address,
      feeAccount: (values["fee-account"] ?? deployment.feeAccount ?? u8aToHex(devKeyring("//Charlie").publicKey)) as Hex,
      weightLimit: { refTime: BigInt(values["weight-ref-time"]!), proofSize: BigInt(values["weight-proof-size"]!) },
      storageDepositLimit: BigInt(values["storage-deposit-limit"]!),
      claimerNetwork: parseNetwork(values["claimer-network"]),
    });
    const output = JSON.stringify({ ...template, xcmHeadBytes: size(template.xcmHead), xcmTailBytes: size(template.xcmTail) }, null, 2);
    if (values.out) writeFileSync(values.out, `${output}\n`);
    console.log(output);
  } finally {
    await api.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
