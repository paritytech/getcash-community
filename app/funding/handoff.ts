// The shell to package contract for the middle of a top-up. The shell owns the amount, the route
// and the post-deposit timeline; a package owns getting money sent and emits `handoff` when done.

import type { FundingRoute } from "./selection";

/** Emits of every package component. `handoff` fires at most once, when the deposit is confirmed.
 *  `switchRoute` asks the shell to swap to another route's package, keeping the amount. */
export type FundingPackageEmits = {
  back: [];
  handoff: [];
  switchRoute: [route: FundingRoute];
};

/** A package's payment status line, shown above the shell's timeline. Null when there is none. */
export interface FundingJourneyStatus {
  text: string;
  tone: "pending" | "done" | "failed";
}
