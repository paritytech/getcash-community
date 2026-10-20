// A trap on People, and how a funding job finds its own.
//
// pallet_xcm keys a trap by the claimer and the assets: the blake2_256 hash of the SCALE encoding
// of the pair (Location, VersionedAssets), the assets in the latest XCM version. The funding
// program names the burner as the claimer and People charges nothing for it, so a trap holds
// exactly the CASH the conversion sent, and its key follows from that amount without reading any
// event. The chain's AssetTraps map counts the traps under a key; one or more means the CASH is
// there, and claim_assets signed by the burner takes it back.
//
// The encoding comes from the chain's own codecs: the AssetsTrapped event carries the hash, the
// origin and the assets in that order, so the pair's encoding is the event payload past the hash.
// The event itself is the second way to find a trap, exact when the amount sent is not known to
// the unit, but it is only in the block it happened in, which a worker asleep then never sees.

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

/** The trap holding `sent` CASH for `claimerHex`, read from People at its best block: the count
 *  under the key `sent` gives, or the AssetsTrapped event of that block naming the claimer, which
 *  also serves when `sent` is off by what the pool moved after it was read. Null when neither
 *  shows one. */
export async function findTrap(
  peopleApi: PeopleApi,
  claimerHex: string,
  sent: bigint,
): Promise<Trap | null> {
  const key = await trapKey(claimerHex, sent);
  const count = await peopleApi.query.PolkadotXcm.AssetTraps.getValue(key, { at: "best" });
  if (count > 0) return { amount: sent, key };
  const events = await peopleApi.query.System.Events.getValue({ at: "best" });
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
