// The rows under the withdrawal's timeline, as the design has them per route and ending: where
// it lands for crypto; the payout, when it arrives, and on failure who took it and the
// reference to quote them for a sale.

import { depositTokenOf, recordedRoute } from "@getsome/funding";
import type { DetailRow } from "../../components/ui/DetailRows.vue";
import { isWithdrawalSideExit, type WithdrawalRecord } from "../../funding/requests/model";
import { asName } from "../../funding/top-up-projection";
import { shortRef } from "../../utils/journey";
import { fmtFiat } from "../../utils/money";
import { formatLanding, shortDestinationAddress } from "../destinations";
import { chainLabel } from "~~/lib/config";

export interface JourneyRowsContext {
  /** The route still holds the quote behind the receive row, so the row opens its fees. */
  readonly feesAvailable: boolean;
}

/**
 * What the withdrawal delivers, as its success screen shows it in place of what left the
 * balance: the fees come out on the way, so the two differ. A direct withdrawal shows what the
 * worker saw arrive on the destination, in its asset. A sale's provider pays out its own figure,
 * so the quote's payout stands in for it, `≈`. Null where none is known.
 */
export function receivedText(record: WithdrawalRecord): string | null {
  if (record.route !== "crypto") {
    const { sale } = record;
    return sale === undefined ? null : `≈ ${fmtFiat(sale.quotedPayout, sale.fiat)}`;
  }
  const worker = record.witnesses.worker;
  const received = worker?.known === true ? worker.received : undefined;
  if (received === undefined) return null;
  const { decimals } = depositTokenOf(recordedRoute(record.handoff));
  return `${formatLanding(BigInt(received), decimals)} ${record.destination.asset}`;
}

const ARRIVES: Readonly<Record<"card" | "bank", DetailRow>> = {
  card: { label: "Arrives", value: "Your bank can take up to 2 days to process" },
  bank: {
    label: "Arrives",
    value: "1–2 business days",
    note: "Final CASH depends on the rate on arrival",
  },
};

function cryptoRows(record: WithdrawalRecord): DetailRow[] {
  // The design's crypto endings carry the band and the way on, no rows.
  if (isWithdrawalSideExit(record)) return [];
  return [
    {
      label: "To this address",
      sublabel: `on ${chainLabel(record.destination.chain)} Network`,
      value: shortDestinationAddress(record.destination.address),
      title: record.destination.address,
    },
  ];
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
  return record.route === "crypto" ? cryptoRows(record) : saleRows(record, record.route, context);
}
