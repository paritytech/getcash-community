// The rows under the withdrawal's timeline, as the design has them per route and ending: what
// lands and where for crypto; the payout, when it arrives, and on failure who took it and the
// reference to quote them for a sale.

import { formatSourceAmount, SOURCE_CONFIG_BY_ID } from "@getsome/chainflip";
import { sourceIdFor } from "~~/lib/config";
import type { DetailRow } from "../../components/ui/DetailRows.vue";
import { isWithdrawalSideExit, type WithdrawalRecord } from "../../funding/requests/model";
import { asName } from "../../funding/top-up-projection";
import { shortRef } from "../../utils/journey";
import { fmtFiat } from "../../utils/money";
import { shortDestinationAddress } from "../destinations";

export interface JourneyRowsContext {
  /** The route still holds the quote behind the receive row, so the row opens its fees. */
  readonly feesAvailable: boolean;
}

/** What the quote said would land, formatted in the destination asset: an estimate, so `≈`.
 *  Nothing for the direct rail, which stores no channel and no promised figure. */
export function expectedEgressText(record: WithdrawalRecord): string | null {
  const egress = record.handoff.channel?.expectedEgress;
  if (egress === undefined) return null;
  const { chain, asset } = record.destination;
  const id = sourceIdFor(chain, asset);
  const config = id === undefined ? undefined : SOURCE_CONFIG_BY_ID.get(id);
  if (config === undefined) return null;
  try {
    return `≈ ${formatSourceAmount(config, egress, { maxDecimals: 6 })} ${asset}`;
  } catch {
    return null;
  }
}

const ARRIVES: Readonly<Record<"card" | "bank", DetailRow>> = {
  card: { label: "Arrives", value: "Your bank can take up to 2 days to process" },
  bank: {
    label: "Arrives",
    value: "1–2 business days",
    note: "Final Cash depends on the rate on arrival",
  },
};

function cryptoRows(record: WithdrawalRecord, { feesAvailable }: JourneyRowsContext): DetailRow[] {
  // The design's crypto endings carry the band and the way on, no rows.
  if (isWithdrawalSideExit(record)) return [];
  const rows: DetailRow[] = [];
  const egress = expectedEgressText(record);
  if (egress !== null) rows.push({ label: "You'll receive", value: egress, fees: feesAvailable });
  rows.push({
    label: "To this address",
    sublabel: `on ${record.destination.chain} Network`,
    value: shortDestinationAddress(record.destination.address),
    title: record.destination.address,
  });
  return rows;
}

function saleRows(
  record: WithdrawalRecord,
  route: "card" | "bank",
  { feesAvailable }: JourneyRowsContext,
): DetailRow[] {
  const { sale } = record;
  if (sale === undefined) return [];
  const payout = fmtFiat(sale.quotedPayout, sale.fiat);
  if (isWithdrawalSideExit(record)) {
    return [
      { label: "Amount", value: payout, fees: feesAvailable },
      { label: "Provider", value: asName(sale.serviceProvider) },
      {
        label: "Transaction ID",
        value: shortRef(sale.fundingRequestId),
        copy: sale.fundingRequestId,
      },
    ];
  }
  const rows: DetailRow[] = [{ label: "You'll receive", value: payout, fees: feesAvailable }];
  // A card's payout is settled with its sending; a bank's still has days to go.
  if (record.status.kind !== "sent" || route === "bank") rows.push(ARRIVES[route]);
  return rows;
}

export function withdrawalJourneyRows(
  record: WithdrawalRecord,
  context: JourneyRowsContext,
): DetailRow[] {
  return record.route === "crypto"
    ? cryptoRows(record, context)
    : saleRows(record, record.route, context);
}
