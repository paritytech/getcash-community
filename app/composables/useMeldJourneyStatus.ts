// Status line for the Meld payment on the journey screen, named after the rail (card payment or
// bank transfer). Null when there is nothing to add.

import { computed } from "vue";
import type { FundingJourneyStatus } from "../funding/handoff";
import { useSessionStore } from "../stores/session";

export function useMeldJourneyStatus() {
  const session = useSessionStore();
  return computed<FundingJourneyStatus | null>(() => {
    if (session.method === "crypto" || session.phase === "done") return null;
    const rail = session.method === "bank" ? "bank transfer" : "card payment";
    const Rail = rail.charAt(0).toUpperCase() + rail.slice(1);
    switch (session.meldStage) {
      case "receiving":
        return { text: `Confirming your ${rail}…`, tone: "pending" };
      case "complete":
        return { text: `${Rail} confirmed`, tone: "done" };
      case "failed":
        // A refund is not a "could not be completed, try again": the money came back. Say so, so
        // the header does not contradict the "money returned" detail below it.
        return session.meldRefunded
          ? { text: "Top-up refunded", tone: "failed" }
          : { text: `${Rail} could not be completed`, tone: "failed" };
      default:
        return null;
    }
  });
}
