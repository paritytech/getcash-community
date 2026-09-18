// The withdrawals as the shell's lists know them: one row per open record, in the same row shape
// the top-up rows use, so the pending and history screens list both kinds unchanged.

import { computed } from "vue";
import { useFundingProgressClock } from "../composables/useFundingProgressClock";
import {
  WITHDRAW_SOURCE_PREFIX,
  isFinished,
  isWithdrawSourceId,
  type WithdrawalRecord,
} from "../funding/requests/model";
import type { FundingTopUpAdapter } from "../funding/top-up-adapter";
import type {
  FundingListWording,
  FundingTopUp,
  FundingTopUpState,
  FundingTopUpWording,
} from "../funding/top-ups";
import { useRequestsStore } from "../stores/requests";
import { parseRequestRefKey, requestRefKey, type RequestRef } from "../utils/request-index";
import { destinationTokenIcon, withdrawDestination, withdrawNetwork } from "./destinations";
import { withdrawalFailureText } from "./failure-copy";
import { withdrawalProgress, withdrawalProgressProfile } from "./progress";

/** The words the rows use for a withdrawal. */
export const WITHDRAWAL_WORDING: FundingTopUpWording = { settled: "Sent" };

/** The words the shell's list screens use on the withdrawal page. */
export const WITHDRAWAL_LIST_WORDING: FundingListWording = {
  pendingTitle: "Withdrawal in progress",
  emptyHistory: "Nothing here yet. Your withdrawals will appear as you make them.",
};

/** A withdrawal row's id: the kind, then the request's identity (`withdraw:wd:dot-assethub#3`). */
const rowId = (ref: RequestRef): string => `withdraw:${requestRefKey(ref)}`;

/** The request a row id names, or null for an id that is not a withdrawal's. */
export function withdrawalRequestRef(id: string): RequestRef | null {
  const match = /^withdraw:(.*)$/.exec(id);
  if (match === null) return null;
  const ref = parseRequestRefKey(match[1]!);
  return ref !== null && isWithdrawSourceId(ref.sourceId) ? ref : null;
}

/** The row's state, worded by the same projection the journey ribbon shows. A cancelled record
 *  is never listed; it reads as failed so the type has a value. */
export function withdrawalRowStateOf(record: WithdrawalRecord, label: string): FundingTopUpState {
  const { status } = record;
  switch (status.kind) {
    case "awaiting-payment":
      return { kind: "awaiting-transfer", status: label };
    case "paid":
    case "converting":
    case "sending":
      return { kind: "finishing", status: label };
    case "sent":
      return { kind: "settled", at: status.at };
    case "failed":
    case "expired":
      return {
        kind: "failed",
        at: status.at,
        ...(record.failure === undefined ? {} : { reason: withdrawalFailureText(record.failure) }),
      };
    case "cancelled":
      return { kind: "failed", at: status.at, reason: "Cancelled" };
  }
}

/** The icon for a destination this build no longer knows. */
const UNKNOWN_ICON = "/icons/crypto.svg";

export function projectWithdrawalTopUps(
  records: readonly WithdrawalRecord[],
  now = Date.now(),
): FundingTopUp[] {
  return records.map((record) => {
    const progress = withdrawalProgress(record, now);
    const destinationId = record.ref.sourceId?.slice(WITHDRAW_SOURCE_PREFIX.length) ?? "";
    const destination = withdrawDestination(destinationId);
    const network = destination === undefined ? undefined : withdrawNetwork(destination.chain);
    return {
      id: rowId(record.ref),
      amount: record.amountHuman,
      route: "crypto",
      startedAt: record.startedAt,
      progress,
      details: {
        network: { label: record.destination.chain, icon: network?.icon ?? UNKNOWN_ICON },
        token: {
          label: record.destination.asset,
          icon: destination === undefined ? UNKNOWN_ICON : destinationTokenIcon(destination),
        },
      },
      state: withdrawalRowStateOf(record, progress.view.label),
    };
  });
}

export function useWithdrawalTopUpAdapter(): FundingTopUpAdapter {
  const requests = useRequestsStore();
  const cadence = computed(() => {
    const moving = requests.openWithdrawals.filter((record) => !isFinished(record));
    return moving.length === 0
      ? null
      : Math.min(
          ...moving.map((record) => withdrawalProgressProfile(record.rail.provider).cadenceMs),
        );
  });
  const now = useFundingProgressClock(cadence);
  return {
    topUps: computed(() => projectWithdrawalTopUps(requests.openWithdrawals, now.value)),
    refresh: () => requests.reconcile("refresh"),
    // A withdrawal has no world to rebuild: bringing it to the front is the record itself.
    open: async (topUp) => {
      const ref = withdrawalRequestRef(topUp.id);
      if (ref === null || !requests.has(ref)) return false;
      requests.setForeground(ref);
      return true;
    },
  };
}
