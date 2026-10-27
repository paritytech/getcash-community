// The 192-byte CCM message a SaleVaultProxyFactory delivery carries, six words (ref, recipient, committed, home, deadline, claimer) in the exact layout cfReceive decodes.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const WORD = 32;
/** The sale message length Chainflip prices into a CCM quote. */
export const SALE_MESSAGE_BYTES = 192;

// A non-negative integer as a right-aligned 32-byte word.
function uintWord(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative value");
  const hex = value.toString(16);
  if (hex.length > WORD * 2) throw new Error("value exceeds 32 bytes");
  return hexToBytes(hex.padStart(WORD * 2, "0"));
}

// A 20-byte EVM address right-aligned into a 32-byte word, the way the contract casts it back.
function addressWord(address: string, what: string): Uint8Array {
  const raw = hexToBytes(address.replace(/^0x/, ""));
  if (raw.length !== 20) throw new Error(`${what} must be a 20-byte address`);
  const out = new Uint8Array(WORD);
  out.set(raw, WORD - raw.length);
  return out;
}

// A 32-byte account id as its own word, left as the raw bytes the chain reads back.
function accountWord(accountHex: string): Uint8Array {
  const raw = hexToBytes(accountHex.replace(/^0x/, ""));
  if (raw.length !== WORD) throw new Error("home account must be 32 bytes");
  return raw;
}

// The payment deadline as the unix seconds the proxy compares, rounded down so it never outlasts the app's.
function deadlineWord(paymentExpiresAt: number): Uint8Array {
  if (!Number.isSafeInteger(paymentExpiresAt)) throw new Error("payment deadline must be epoch ms");
  const seconds = BigInt(Math.floor(paymentExpiresAt / 1000));
  if (seconds <= 0n) throw new Error("payment deadline must be after the epoch");
  return uintWord(seconds);
}

/** The on-chain sale key the contract and the adapter share: keccak256 of the id as its UTF-8 bytes. */
export function saleRef(fundingRequestId: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(fundingRequestId)))}`;
}

/** The exact terms a SaleVaultProxy sale commits to, before encoding. */
export interface SaleMessage {
  /** The funding request this sale belongs to, whose keccak is the on-chain ref. */
  fundingRequestId: string;
  /** The Meld deposit address the sale pays on the destination chain. */
  recipient: string;
  /** The exact amount the sale promises the provider, in the destination asset's base units. */
  committed: bigint;
  /** The seller's Asset Hub account, where a return goes, as a 32-byte hex account id. */
  home: string;
  /** The sale's payment deadline in epoch ms, as the record keeps it. Past it the proxy holds the delivery. */
  paymentExpiresAt: number;
  /** The seller's Arbitrum address a held sale releases to, bound into the proxy's address. */
  claimer: string;
}

/** The 192-byte CCM message for a SaleVaultProxy sale, as 0x-hex: ref, recipient, committed, home, deadline, claimer. */
export function encodeSaleMessage(message: SaleMessage): string {
  const out = new Uint8Array(SALE_MESSAGE_BYTES);
  out.set(hexToBytes(saleRef(message.fundingRequestId).slice(2)), 0);
  out.set(addressWord(message.recipient, "recipient"), WORD);
  out.set(uintWord(message.committed), WORD * 2);
  out.set(accountWord(message.home), WORD * 3);
  out.set(deadlineWord(message.paymentExpiresAt), WORD * 4);
  const claimer = addressWord(message.claimer, "claimer");
  // The factory books a zero claimer as unattributed, so it is never sent
  if (claimer.every((b) => b === 0)) throw new Error("claimer must not be the zero address");
  out.set(claimer, WORD * 5);
  return `0x${bytesToHex(out)}`;
}
