// A trap on People, and how a funding job finds its own.
//
// pallet_xcm keys a trap by the claimer and the assets: the blake2_256 hash of the SCALE encoding
// of the pair (Location, VersionedAssets), the assets in the latest XCM version. The funding
// program names the burner as the claimer, so a trap holds the CASH the conversion sent less
// whatever fee People charged before the failure, and that charge is the one unknown: nothing on
// some runtimes, a few units on others, never more than a whole program's. So the trap is found by
// trying: the chain's AssetTraps map is read whole, it holds a handful of entries, and the keys
// for every amount from the one sent down by twice the fee the dry run saw are computed locally
// until one is in the map. One or more counted under it means the CASH is there, and
// claim_assets signed by the burner takes it back.
//
// The encoding comes from the chain's own codecs: the AssetsTrapped event carries the hash, the
// origin and the assets in that order, so the pair's encoding is the event payload past the hash.
// The event itself is the second way to find a trap, exact whatever was charged, but it is only in
// the block it happened in, which a worker asleep then never sees.

import { blake2b } from "@noble/hashes/blake2.js";
import { TOKENS } from "@getsome/core";
import { paseo_people_next } from "@polkadot-api/descriptors";
import { getTypedCodecs, type HexString } from "polkadot-api";
import { claimer, type PeopleApi } from "./funding-program";

/** A trap holding the burner's CASH on People: what it holds and the key AssetTraps counts it
 *  under, which is what a claim must name. */
export interface Trap {
  amount: bigint;
  key: HexString;
}

const ZERO_HASH = `0x${"00".repeat(32)}`;

const toHex = (bytes: Uint8Array): HexString =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

let codecs: ReturnType<typeof getTypedCodecs<typeof paseo_people_next>> | null = null;
/** The People codecs, built once from the descriptors; no chain is read. */
const peopleCodecs = () => (codecs ??= getTypedCodecs(paseo_people_next));

/** `amount` CASH as a trap holds it: keyed as People keys CASH, in the latest XCM version. */
export const trappedCash = (amount: bigint) => ({
  type: "V5",
  value: [{ id: TOKENS.CASH.locationOnPeople, fun: { type: "Fungible", value: amount } }],
});

/** The key People files a trap of `amount` CASH under when `claimerHex` is its claimer. */
export async function trapKey(claimerHex: string, amount: bigint): Promise<HexString> {
  const { event } = await peopleCodecs();
  const payload = event.PolkadotXcm.AssetsTrapped.enc({
    hash: ZERO_HASH,
    origin: claimer(claimerHex),
    assets: trappedCash(amount),
  } as never);
  return toHex(blake2b(payload.subarray(32), { dkLen: 32 }));
}

type Junction = { type: string; value?: { type?: string; value?: { id?: unknown } } };

/** Whether `origin`, as an event carries it, is `claimerHex` as its own signed origin. */
function namesClaimer(origin: unknown, claimerHex: string): boolean {
  const location = origin as { parents?: number; interior?: Junction };
  if (location.parents !== 0 || location.interior?.type !== "X1") return false;
  const junction = location.interior.value;
  if (junction?.type !== "AccountId32") return false;
  const id = junction.value?.id as string | { asHex: () => string } | undefined;
  const hex = typeof id === "string" ? id : id?.asHex();
  return hex?.toLowerCase() === claimerHex.toLowerCase();
}

/** The amount of the one fungible asset a trap event names, if it is one. */
function trappedAmountOf(assets: unknown): bigint | null {
  const list = (assets as { value?: Array<{ fun?: { type?: string; value?: bigint } }> }).value;
  const first = Array.isArray(list) && list.length === 1 ? list[0] : undefined;
  return first?.fun?.type === "Fungible" ? BigInt(first.fun.value ?? 0n) : null;
}

/** The most amounts a scan tries, both sides together: a bound on the worker's time, whatever
 *  the fee came to. */
export const TRAP_SCAN_MAX = 50_000n;
/** Amounts tried beyond twice the fee, for a charge that moved a little since the dry run. */
const TRAP_SCAN_SLACK = 100n;

/** How far from the amount sent a scan looks, each way: twice the fee People's dry run charged,
 *  since a failing program is charged at most what a whole one is, plus a little slack; never
 *  past half of TRAP_SCAN_MAX. Without a dry-run figure, the slack alone. */
export function trapScanSpan(peopleFee: bigint | null): bigint {
  const span = 2n * (peopleFee ?? 0n) + TRAP_SCAN_SLACK;
  const most = TRAP_SCAN_MAX / 2n;
  return span < most ? span : most;
}

/** The trap holding the CASH sent for `claimerHex`, read from People at its finalized block: the
 *  entry whose key one of the amounts within `span` of `sent` gives, or the AssetsTrapped event
 *  of that block naming the claimer. The scan looks above `sent` as well as below: while the
 *  figure is still the dry run's, the pool may have filled more or less than it saw. Null when
 *  neither shows one. */
export async function findTrap(
  peopleApi: PeopleApi,
  claimerHex: string,
  sent: bigint,
  span: bigint,
): Promise<Trap | null> {
  // Read at the finalized block, as the arrival is: a trap ends the conversion for good, and a
  // trap seen in a best block the chain then replaces would end it for nothing.
  const entries = await peopleApi.query.PolkadotXcm.AssetTraps.getEntries({ at: "finalized" });
  const counted = new Set(
    entries.filter((entry) => entry.value > 0).map((entry) => entry.keyArgs[0].toLowerCase()),
  );
  if (counted.size > 0) {
    const most = TRAP_SCAN_MAX / 2n;
    const reach = span < most ? span : most;
    const floor = sent - reach > 1n ? sent - reach : 1n;
    for (let amount = sent + reach; amount >= floor; amount -= 1n) {
      const key = await trapKey(claimerHex, amount);
      if (counted.has(key.toLowerCase())) return { amount, key };
    }
  }
  const events = await peopleApi.query.System.Events.getValue({ at: "finalized" });
  for (const record of events) {
    const event = record.event as { type: string; value: { type: string; value: unknown } };
    if (event.type !== "PolkadotXcm" || event.value.type !== "AssetsTrapped") continue;
    const { hash, origin, assets } = event.value.value as {
      hash: HexString;
      origin: unknown;
      assets: unknown;
    };
    if (!namesClaimer(origin, claimerHex)) continue;
    const amount = trappedAmountOf(assets);
    if (amount !== null) return { amount, key: hash };
  }
  return null;
}
