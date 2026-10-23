// The 128-byte CCM message a SaleVault swap carries, four words (ref, recipient, committed, home) in the exact layout cfReceive decodes.

import { keccak_256 } from "@noble/hashes/sha3.js";

const WORD = 32;
const MESSAGE_BYTES = 128;

function stripHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = stripHex(hex);
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// A non-negative integer as a right-aligned 32-byte word.
function uintWord(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative value");
  let hex = value.toString(16);
  if (hex.length > WORD * 2) throw new Error("value exceeds 32 bytes");
  return hexToBytes(hex.padStart(WORD * 2, "0"));
}

// A 20-byte EVM address right-aligned into a 32-byte word, the way the contract casts it back.
function addressWord(address: string): Uint8Array {
  const raw = hexToBytes(address);
  if (raw.length !== 20) throw new Error("recipient must be a 20-byte address");
  const out = new Uint8Array(WORD);
  out.set(raw, WORD - raw.length);
  return out;
}

// A 32-byte account id as its own word, left as the raw bytes the chain reads back.
function accountWord(accountHex: string): Uint8Array {
  const raw = hexToBytes(accountHex);
  if (raw.length !== WORD) throw new Error("home account must be 32 bytes");
  return raw;
}

/** The on-chain sale key the contract and the adapter share: keccak256 of the id as its UTF-8 bytes. */
export function saleRef(fundingRequestId: string): string {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(fundingRequestId)))}`;
}

/** The exact terms a SaleVault swap commits to, before encoding. */
export interface SaleMessage {
  /** The funding request this sale belongs to; its keccak is the on-chain ref. */
  fundingRequestId: string;
  /** The Meld deposit address the sale pays on the destination chain. */
  recipient: string;
  /** The exact amount the sale promises the provider, in the destination asset's base units. */
  committed: bigint;
  /** The seller's Asset Hub account, where a return goes, as a 32-byte hex account id. */
  home: string;
}

/** The 128-byte CCM message for a SaleVault swap, as 0x-hex: ref, recipient, committed, home. */
export function encodeSaleMessage(message: SaleMessage): string {
  const out = new Uint8Array(MESSAGE_BYTES);
  out.set(hexToBytes(saleRef(message.fundingRequestId)), 0);
  out.set(addressWord(message.recipient), WORD);
  out.set(uintWord(message.committed), WORD * 2);
  out.set(accountWord(message.home), WORD * 3);
  return `0x${bytesToHex(out)}`;
}
