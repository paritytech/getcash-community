// Readers for what a dry run reports, shared by every program that runs on both chains: the
// origins a dry run is asked from, the program a chain forwards to a sibling, what a run traps,
// and what it credits to an account.

import { AccountId } from "polkadot-api";

/** A signed origin for `DryRunApi.dry_run_call`. */
export const signedOrigin = (from: string) => ({
  type: "system",
  value: { type: "Signed", value: from },
});

/** A sibling parachain as the receiving chain sees it: the origin of a forwarded program. */
export const siblingOrigin = (paraId: number) => ({
  type: "V5",
  value: {
    parents: 1,
    interior: { type: "X1", value: { type: "Parachain", value: paraId } },
  },
});

/** The program a dry run forwards to the sibling `paraId`, or null when nothing goes there. */
export function forwardedTo(effects: unknown, paraId: number): unknown | null {
  const forwarded = (effects as { forwarded_xcms?: Array<[unknown, unknown[]]> }).forwarded_xcms;
  const match = forwarded?.find(([dest]) => {
    const loc = (
      dest as { value?: { parents?: number; interior?: { value?: { value?: number } } } }
    ).value;
    return loc?.parents === 1 && loc?.interior?.value?.value === paraId;
  });
  return match?.[1]?.[0] ?? null;
}

/** The fungible total the PolkadotXcm.AssetsTrapped events of a dry run report. */
export function trappedIn(events: readonly unknown[]): bigint {
  let total = 0n;
  for (const ev of events) {
    const e = ev as { type?: string; value?: { type?: string; value?: { assets?: unknown } } };
    if (e.type !== "PolkadotXcm" || e.value?.type !== "AssetsTrapped") continue;
    const assets = (e.value.value?.assets as { value?: unknown })?.value;
    for (const a of Array.isArray(assets) ? assets : []) {
      const fun = (a as { fun?: { type?: string; value?: bigint } }).fun;
      if (fun?.type === "Fungible") total += BigInt(fun.value ?? 0n);
    }
  }
  return total;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** True when the SS58 `who` names the public key `hex`, whatever prefix the chain prints. */
const isAccount = (who: string, hex: string): boolean =>
  `0x${toHex(AccountId().enc(who))}` === hex.toLowerCase();

/** What a dry run credited to the account `beneficiaryHex`: the fungible asset's Deposited
 *  events for `asset`, the native's Deposit events for `native`. */
export function creditedTo(
  events: readonly unknown[],
  beneficiaryHex: string,
  kind: "asset" | "native",
): bigint {
  const [pallet, name] = kind === "asset" ? ["Assets", "Deposited"] : ["Balances", "Deposit"];
  let total = 0n;
  for (const ev of events) {
    const e = ev as {
      type?: string;
      value?: { type?: string; value?: { who?: string; amount?: bigint } };
    };
    if (e.type !== pallet || e.value?.type !== name) continue;
    const { who, amount } = e.value.value ?? {};
    if (who !== undefined && amount !== undefined && isAccount(who, beneficiaryHex)) {
      total += BigInt(amount);
    }
  }
  return total;
}
