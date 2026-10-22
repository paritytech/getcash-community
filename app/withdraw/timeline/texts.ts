// What the withdrawal's journey says: the band under the timeline per phase, the wait before it,
// and the list's words for a sale before its balance is asked.

import {
  saleAwaitingDeposit,
  SENDING_STEP_ORDER,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import { liveDetail, reader, stages } from "../../funding/timeline/live";
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

/** The worker's step on the conversion, as an order, when the record is on it. */
function sendingStep(record: WithdrawalRecord): number | undefined {
  const { status } = record;
  return status.kind === "converting" ? SENDING_STEP_ORDER[status.step] : undefined;
}

/** Who the phase's read names, delayed or not: the rail on the hand-off and the exchange, unless
 *  the direct rail, which is the arrival itself; otherwise the worker's tick, a check either way. */
function readLabel(record: WithdrawalRecord, index: number): string {
  if (index < 2 || index > 3 || record.rail.provider === "direct") return "Checked";
  return record.route === "crypto" ? "Checked with the exchange" : "Checked with the provider";
}

/** The live detail per phase: the stages the worker is through where it reports them, and when
 *  whoever moves the phase was last read. */
function phaseDetail(
  record: WithdrawalRecord,
  index: number,
  state: TextState,
): string | undefined {
  const { live } = state;
  const read = reader(state);
  const step = sendingStep(record);
  if (state.delayed) return read(readLabel(record, index));
  switch (index) {
    case 0:
      return liveDetail(
        live,
        stages(["Swapped", "Converted"], step === undefined ? 0 : Math.min(step, 2)),
        read("checked"),
      );
    case 1:
      return record.handoff.tier === "psm"
        ? liveDetail(
            live,
            stages(
              ["Arrived", "Redeemed"],
              step === SENDING_STEP_ORDER.redeem || record.failure?.kind === "held" ? 1 : 0,
            ),
            read("checked"),
          )
        : read("Checked");
    default:
      return read(readLabel(record, index));
  }
}

export function withdrawalText(
  record: WithdrawalRecord,
  index: number,
  state: TextState,
): TimelineText {
  const detail = phaseDetail(record, index, state);
  // The conversion is phases 0 and 1; from the hand-off on, a delay is the rail's.
  const message = state.delayed
    ? delay(index < 2 ? CONVERSION_DELAYED : RAIL_DELAYED)
    : normal(phaseText(record, index));
  return detail === undefined ? { message } : { message, detail };
}
