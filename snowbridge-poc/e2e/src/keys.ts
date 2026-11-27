import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { bytesToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { devKeyring } from "../../assethub/src/chain";
import { ENV_LOCAL } from "./config";

export type Keys = {
  adminKey: Hex;
  triggerKey: Hex;
  guardianKey: Hex;
  payerSeed: Hex;
  feeAccountSeed: Hex;
};

const NAMES: Record<keyof Keys, string> = {
  adminKey: "ADMIN_KEY",
  triggerKey: "TRIGGER_KEY",
  guardianKey: "GUARDIAN_KEY",
  payerSeed: "PAYER_SEED",
  feeAccountSeed: "FEE_ACCOUNT_SEED",
};

const seed = (): Hex => `0x${randomBytes(32).toString("hex")}`;

export function generateKeys(): Keys {
  return { adminKey: generatePrivateKey(), triggerKey: generatePrivateKey(), guardianKey: generatePrivateKey(), payerSeed: seed(), feeAccountSeed: seed() };
}

// The previous keys are kept next to the file: they control the previous payer's funds in the previous pool.
export function writeKeys(keys: Keys): string | undefined {
  const backup = existsSync(ENV_LOCAL) ? `${ENV_LOCAL}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak` : undefined;
  if (backup) copyFileSync(ENV_LOCAL, backup);
  if (backup) chmodSync(backup, 0o600);
  const lines = (Object.keys(NAMES) as (keyof Keys)[]).map((field) => `${NAMES[field]}=${keys[field]}`);
  writeFileSync(ENV_LOCAL, `${lines.join("\n")}\n`, { mode: 0o600 });
  return backup;
}

export function readKeys(): Keys {
  if (!existsSync(ENV_LOCAL)) throw new Error(`${ENV_LOCAL} is missing; run the deploy first`);
  const env = parseEnv(readFileSync(ENV_LOCAL, "utf8"));
  const keys = {} as Keys;
  for (const field of Object.keys(NAMES) as (keyof Keys)[]) {
    const value = env[NAMES[field]];
    if (!value) throw new Error(`${NAMES[field]} is missing from ${ENV_LOCAL}`);
    keys[field] = value as Hex;
  }
  return keys;
}

export function identities(keys: Keys) {
  const payer = devKeyring(keys.payerSeed);
  const fee = devKeyring(keys.feeAccountSeed);
  return {
    admin: privateKeyToAccount(keys.adminKey),
    trigger: privateKeyToAccount(keys.triggerKey),
    guardian: privateKeyToAccount(keys.guardianKey),
    payer: { pair: payer, account: bytesToHex(payer.publicKey), ss58: payer.address },
    feeAccount: { pair: fee, account: bytesToHex(fee.publicKey), ss58: fee.address },
  };
}
