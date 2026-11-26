// The three hops of a Snowbridge message in dry runs: Asset Hub, Hydration, and Asset Hub again.
// It shows what a message does and what the account gets before any ether leaves Ethereum.
// Nothing is sent.

import { AccountId } from "polkadot-api";
import {
  ASSET_HUB,
  BRIDGE_HUB,
  dryRunXcm,
  HYDRATION,
  type ChainEvent,
  type ChainReader,
  type XcmDryRun,
} from "./chain";
import { deliveredProgram, type SnowbridgeMessage } from "./wrapper";

/** The number of USDT on Asset Hub. */
const USDT_ON_ASSET_HUB = 1984;

export interface SnowbridgeHops {
  /** The message on Asset Hub, as Bridge Hub delivers it. */
  assetHub: XcmDryRun;
  /** What Asset Hub sends, on Hydration. Null when Asset Hub sends nothing there. */
  hydration: XcmDryRun | null;
  /** What Hydration sends back, on Asset Hub. Null when Hydration sends nothing back. */
  deposit: XcmDryRun | null;
  /** The USDT the last hop gives the account, in base units. */
  usdt: bigint;
  /** The ether the last hop gives the account, in wei: the ether of a swap that failed. */
  ether: bigint;
  /** The ether the first hop leaves on the account, in wei: the unused part of the execution fee
   *  and the minimum balance. */
  etherKept: bigint;
}

const hexOf = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/** True when `who`, an address in the form a chain prints, is the account `account`. */
function isAccount(who: unknown, account: string): boolean {
  if (typeof who !== "string") return false;
  try {
    return hexOf(AccountId().enc(who)) === account.toLowerCase();
  } catch {
    return false;
  }
}

/** The sum of the deposits to `account` that `events` name and `wanted` accepts. */
function deposited(
  events: ChainEvent[],
  pallet: string,
  account: string,
  wanted: (assetId: unknown) => boolean,
): bigint {
  let total = 0n;
  for (const { pallet: from, name, fields } of events) {
    if (from !== pallet || name !== "Deposited" || !wanted(fields.asset_id)) continue;
    if (isAccount(fields.who, account) && typeof fields.amount === "bigint") total += fields.amount;
  }
  return total;
}

const isUsdt = (assetId: unknown): boolean => assetId === USDT_ON_ASSET_HUB;

/** True for ether: the one asset Asset Hub names from two levels up with a single junction. */
const isEther = (assetId: unknown): boolean => {
  const location = assetId as { parents?: unknown; interior?: { type?: unknown } } | undefined;
  return location?.parents === 2 && location.interior?.type === "X1";
};

const usdtTo = (run: XcmDryRun, account: string) =>
  deposited(run.events, "Assets", account, isUsdt);
const etherTo = (run: XcmDryRun, account: string) =>
  deposited(run.events, "ForeignAssets", account, isEther);

/** Runs `message` on the three hops and reads what `account` gets. `account` is the request's
 *  account on Asset Hub, as 0x and 64 hex digits. A hop that stops says so in its own result. A
 *  swap that fails on Hydration still sends the ether back, so the last hop runs for it too. */
export async function runSnowbridgeHops(
  chains: { assetHub: ChainReader; hydration: ChainReader },
  message: SnowbridgeMessage,
  account: string,
): Promise<SnowbridgeHops> {
  const assetHub = await dryRunXcm(chains.assetHub, BRIDGE_HUB, deliveredProgram(message));
  const toHydration = assetHub.forwardedTo(HYDRATION);
  const hydration =
    toHydration === null ? null : await dryRunXcm(chains.hydration, ASSET_HUB, toHydration);
  const back = hydration?.forwardedTo(ASSET_HUB) ?? null;
  const deposit = back === null ? null : await dryRunXcm(chains.assetHub, HYDRATION, back);
  return {
    assetHub,
    hydration,
    deposit,
    usdt: deposit === null ? 0n : usdtTo(deposit, account),
    ether: deposit === null ? 0n : etherTo(deposit, account),
    etherKept: etherTo(assetHub, account),
  };
}
