// What the buyer reads off a native bank order to make the transfer from their own bank: one
// copyable row per detail the order carries, and the line that leads them.

import type { BankInstructions } from "@getsome/meld";
import { fmtFiat } from "../utils/money";

export interface BankDetailRow {
  label: string;
  value: string;
  /** The exact text the transfer needs, which `value` may only display. */
  copy: string;
  note?: string;
}

/** "DE89 3704 0044 0532 0130 00", the way an IBAN is printed; copied without the spaces. */
function groupedIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * The transfer's details in the order the buyer enters them. A row appears only for a detail the
 * order carries, so one list serves SEPA (IBAN, BIC), ACH (account and routing number) and PIX.
 */
export function bankDetailRows(instructions: BankInstructions): BankDetailRow[] {
  const rows: BankDetailRow[] = [
    {
      label: "Amount",
      value: fmtFiat(instructions.amount, instructions.currency),
      copy: instructions.amount,
    },
  ];
  const add = (label: string, copy: string | undefined, value = copy): void => {
    if (copy !== undefined) rows.push({ label, value: value ?? copy, copy });
  };
  add("Account name", instructions.accountHolderName);
  const iban = instructions.iban?.replace(/\s+/g, "");
  if (iban !== undefined) add("IBAN", iban, groupedIban(iban));
  add("Account number", instructions.accountNumber);
  add("Routing number", instructions.routingNumber);
  add("PIX key", instructions.pixKey);
  add("BIC", instructions.bic);
  if (instructions.reference !== undefined) {
    rows.push({
      label: "Reference",
      value: instructions.reference,
      copy: instructions.reference,
      note: "Required on the transfer",
    });
  }
  return rows;
}

/** The line above the details: who sends, by when, and that they serve this top-up only. */
export function bankDetailsLead(instructions: BankInstructions, locale?: string): string {
  const by =
    instructions.expiresAt === undefined
      ? ""
      : `, by ${new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(instructions.expiresAt))}`;
  return `Send from a bank account in your name${by}. Use these details for this top-up only.`;
}
