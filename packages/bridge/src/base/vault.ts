// The vault on Base that takes USDC, and the facilitator on Hydration that mints the same amount
// of HOLLAR for it. The reads say if the route is open and how much it can take now. The approval
// and the deposit are the two transactions that follow the swap.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { abiAddress, abiUint, addressAt, encodeCall, wordAt } from "../evm-abi";
import type { EvmLog, EvmRpc } from "../evm-rpc";
import type { EvmTransactionCall } from "../evm-tx";
import { BASE_USDC } from "./chain";

/** The vault on Base. */
export const BASE_VAULT = "0xd5fd74f570343245afce4a4c0b24b59179cfdfa7";

/** The contract on Hydration that mints the HOLLAR. */
export const HOLLAR_FACILITATOR = "0xda30cfdf3647c291cb3b0eed6ac5f0fea7f393c4";

type Reader = Pick<EvmRpc, "call">;

/** What the vault and the facilitator say now. The amounts of USDC are in its base units. */
export interface VaultState {
  /** True when the vault takes no deposit. */
  depositsPaused: boolean;
  /** The USDC the vault's own limit lets in now. Zero while it is paused. */
  depositAllowance: bigint;
  /** True when Hydration mints no HOLLAR for a deposit. */
  mintPaused: boolean;
  /** The USDC that Hydration can mint HOLLAR for now. Zero while it is paused. */
  mintHeadroom: bigint;
  /** The price of USDC that the vault reads, and the least it accepts for a deposit. */
  usdcPrice: bigint;
  minUsdcPrice: bigint;
  /** The wei a deposit must carry for the message to Hydration. */
  messageFee: bigint;
}

/** What a function with no arguments returns, as a number and as an address. */
const number = async (rpc: Reader, to: string, signature: string): Promise<bigint> =>
  wordAt(await rpc.call({ to, data: encodeCall(signature) }), 0);
const address = async (rpc: Reader, to: string, signature: string): Promise<string> =>
  addressAt(await rpc.call({ to, data: encodeCall(signature) }), 0);

/** The price of USDC as the vault itself reads it before a deposit: it asks its address book for
 *  the price oracle, and the oracle for the price. */
async function usdcPriceOf(base: Reader): Promise<bigint> {
  const book = await address(base, BASE_VAULT, "addressesProvider()");
  const oracle = await address(base, book, "getPriceOracle()");
  const price = await base.call({
    to: oracle,
    data: encodeCall("getAssetPrice(address)", [abiAddress(BASE_USDC)]),
  });
  return wordAt(price, 0);
}

/** The wei the message of a deposit costs, from the messaging contract the vault uses. */
async function messageFeeOf(base: Reader): Promise<bigint> {
  return number(base, await address(base, BASE_VAULT, "wormhole()"), "messageFee()");
}

/** Reads the vault on Base and the facilitator on Hydration. Nothing is sent. */
export async function readVault(base: Reader, hydration: Reader): Promise<VaultState> {
  const [paused, allowance, minimum, price, fee, mintPaused, headroom] = await Promise.all([
    number(base, BASE_VAULT, "depositsPaused()"),
    number(base, BASE_VAULT, "depositAllowance()"),
    number(base, BASE_VAULT, "minUsdcPrice()"),
    usdcPriceOf(base),
    messageFeeOf(base),
    number(hydration, HOLLAR_FACILITATOR, "mintPaused()"),
    number(hydration, HOLLAR_FACILITATOR, "mintHeadroom()"),
  ]);
  return {
    depositsPaused: paused !== 0n,
    depositAllowance: allowance,
    mintPaused: mintPaused !== 0n,
    mintHeadroom: headroom,
    usdcPrice: price,
    minUsdcPrice: minimum,
    messageFee: fee,
  };
}

/** Why the route cannot take `usdc` now, or null when it can. The room is shared by every user
 *  of the vault, so this is asked at the quote and again just before the deposit. */
export function vaultRefusal(state: VaultState, usdc: bigint): string | null {
  if (state.depositsPaused) return "the vault takes no deposits now";
  if (state.mintPaused) return "Hydration mints no HOLLAR now";
  if (state.minUsdcPrice === 0n || state.usdcPrice < state.minUsdcPrice) {
    return "USDC is under the price the vault accepts";
  }
  const room =
    state.depositAllowance < state.mintHeadroom ? state.depositAllowance : state.mintHeadroom;
  if (usdc > room) return `the vault has room for ${room} and the top-up needs ${usdc}`;
  return null;
}

/** The call that lets the vault take `usdc` of the caller's USDC. getcash sends it from a key of
 *  its own on purpose, so that a top-up needs no forwarder contract and no relayer.
 *  TODO: remove this function once a forwarder makes the deposit. */
export function approveVault(usdc: bigint): EvmTransactionCall {
  return {
    to: BASE_USDC,
    value: 0n,
    data: encodeCall("approve(address,uint256)", [abiAddress(BASE_VAULT), abiUint(usdc)]),
  };
}

/** The call that deposits `usdc` of the caller's USDC, for HOLLAR on the Hydration account of the
 *  Ethereum address `recipient`. The call carries the fee of the message.
 *  TODO: remove this function once a forwarder makes the deposit. */
export function vaultDeposit(input: {
  usdc: bigint;
  recipient: string;
  messageFee: bigint;
}): EvmTransactionCall {
  if (input.usdc <= 0n) throw new Error("the deposit must be more than zero");
  return {
    to: BASE_VAULT,
    value: input.messageFee,
    data: encodeCall("deposit(uint256,bytes32)", [
      abiUint(input.usdc),
      abiAddress(input.recipient),
    ]),
  };
}

/** The topic of the event the vault emits for a deposit. */
export const DEPOSITED_TOPIC = `0x${bytesToHex(
  keccak_256(utf8ToBytes("Deposited(address,bytes32,uint256,uint64)")),
)}`;

/** A deposit as the vault's event states it. */
export interface VaultDeposited {
  /** The account that made the deposit, in lower case. */
  from: string;
  /** The Ethereum address that gets the HOLLAR on Hydration, in lower case. */
  recipient: string;
  /** The USDC the vault received. */
  usdc: bigint;
  /** The number of the message to Hydration. */
  sequence: bigint;
}

/** The deposit in `log`, or null when the log is not the vault's event for a deposit. */
export function vaultDeposited(log: EvmLog): VaultDeposited | null {
  if (log.address.toLowerCase() !== BASE_VAULT) return null;
  const [topic, from, recipient] = log.topics;
  if (topic?.toLowerCase() !== DEPOSITED_TOPIC || from === undefined || recipient === undefined) {
    return null;
  }
  const word = (topicHex: string) => `0x${topicHex.slice(-40).toLowerCase()}`;
  return {
    from: word(from),
    recipient: word(recipient),
    usdc: wordAt(log.data, 0),
    sequence: wordAt(log.data, 1),
  };
}
