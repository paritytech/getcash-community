// What the deposit QR encodes. A wallet that scans a payment URI, BIP 21, EIP 681 or Solana Pay,
// fills in the address, the amount and the token itself; the swap package builds the URI for each
// chain it serves. The bare address is the answer everywhere else: a deposit that goes straight to
// the request's own account, a chain with no scheme, such as Tron, and a figure that is only an
// estimate. The copy row carries the bare address in every case.

import { SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import type { SourceId } from "@getsome/core";
import { railProviderOf } from "./requests/model";

export interface DepositQrInput {
  /** The source the request runs under. */
  sourceId: string;
  address: string;
  /** The deposit in the source asset's base units. */
  amount: string;
  /** The figure is the channel's own, not an estimate drawn beside it. */
  exact: boolean;
}

export function depositQrValue(input: DepositQrInput): string {
  const { sourceId, address, amount, exact } = input;
  if (!exact || address === "" || railProviderOf(sourceId) !== "chainflip") return address;
  const source = SOURCE_CONFIG_BY_ID.get(sourceId as SourceId);
  if (source === undefined) return address;
  try {
    const units = BigInt(amount);
    return units > 0n ? source.buildDepositUri(address, units) : address;
  } catch {
    return address;
  }
}
