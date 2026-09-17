import { AccountId } from "polkadot-api";
import { PEOPLE_SS58_PREFIX } from "./constants";

export type Hex32 = `0x${string}`;

export interface WithdrawalAccount {
  publicKey: Uint8Array;
  publicKeyHex: Hex32;
  address: string;
}

export function withdrawalAccountFromPublicKey(publicKey: Uint8Array): WithdrawalAccount {
  if (publicKey.length !== 32) {
    throw new Error(`withdrawal public key must be 32 bytes, got ${publicKey.length}`);
  }
  const publicKeyCopy = Uint8Array.from(publicKey);
  return {
    publicKey: publicKeyCopy,
    publicKeyHex: bytesToHex(publicKeyCopy),
    address: AccountId(PEOPLE_SS58_PREFIX).dec(publicKeyCopy),
  };
}

export function bytesToHex(bytes: Uint8Array): Hex32 {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
