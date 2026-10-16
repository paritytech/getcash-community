// What the withdrawal's journey says: the band under the timeline per phase, the wait before it,
// and the list's words for a sale before its balance is asked.

import { saleAwaitingDeposit, type WithdrawalRecord } from "../../funding/requests/model";
import { delay, normal, type TextState, type TimelineText } from "../../funding/timeline/route";

/** What a fiat sale waits on before its balance is asked: the seller's KYC with the provider. */
export const SALE_KYC_LABEL = "Waiting for you to finish with the provider";

/** A fiat sale past KYC whose balance is not asked yet: its screen asks, so the list sends the
 *  seller there. */
export const SALE_READY_LABEL = "Verified. Open it to pay from your balance";

export const WAITING_FOR_PAYMENT = "Waiting for your payment";
/** The funding product is approved without a sheet, so a requested payment is processing. */
export const PAYMENT_PROCESSING = "Your payment is being processed";
export const CANCELLED_TEXT = "This withdrawal was cancelled.";

/** The band before the first milestone. A sale asks the balance only once the provider knows
 *  where the funds go. */
export function waitingText(record: WithdrawalRecord): string {
  if (saleAwaitingDeposit(record)) return SALE_KYC_LABEL;
  return record.payment.requestedAt === undefined ? WAITING_FOR_PAYMENT : PAYMENT_PROCESSING;
}

const CONVERTING = "Converting your Cash";
const CONVERSION_DELAYED =
  "The conversion is taking longer than usual. It will continue automatically.";
const RAIL_DELAYED = "Your Cash is ready and waiting for the network to confirm it";

/** The band per phase, for the exchange a crypto withdrawal goes through and the payment
 *  provider a sale does. */
function phaseText(record: WithdrawalRecord, index: number): string {
  const { route } = record;
  if (route === "crypto") {
    const { asset } = record.destination;
    switch (index) {
      case 0:
        return CONVERTING;
      case 1:
        // The direct rail delivers with the arrival itself: nothing is exchanged.
        return record.rail.provider === "direct"
          ? `Sending your ${asset} to your wallet`
          : "Moving your money to the exchange";
      case 2:
        return "Handing your money to the exchange";
      case 3:
        return `Exchanging your money for ${asset}`;
      case 4:
        return `Sending your ${asset}`;
      default:
        return `Your ${asset} is on its way to your wallet`;
    }
  }
  switch (index) {
    case 0:
      return CONVERTING;
    case 1:
      return "Moving your money to the payment provider";
    case 2:
      return "Handing your money to the payment provider";
    case 3:
      return "The provider is preparing your payout";
    default:
      return `Sending the money to your ${route}`;
  }
}

export function withdrawalText(
  record: WithdrawalRecord,
  index: number,
  { delayed }: TextState,
): TimelineText {
  if (!delayed) return { message: normal(phaseText(record, index)) };
  // The conversion is phases 0 and 1; from the hand-off on, a delay is the rail's.
  return { message: delay(index < 2 ? CONVERSION_DELAYED : RAIL_DELAYED) };
}
