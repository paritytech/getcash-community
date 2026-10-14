// Where the preview deck wants the shell while a scene is on screen.
//
// A scene only writes store state; the shell's containers are its own. Cycling a scene that
// belongs to a package or the journey while the list has the screen (or the other way round) left
// the state unread and the screen unchanged, so the deck looked stuck. The scene names it wants
// here, and `app/pages/index.vue` puts it there before the scene's state is applied.

import { shallowRef } from "vue";
import type { MeldSellQuote } from "../composables/useMeldSellQuote";
import type { FundingRoute } from "../funding/selection";
import type { WithdrawFeeView } from "../withdraw/offers";

export type PreviewStage =
  /** The shell's own screens: the top-ups list, history, the amount screen. */
  | { kind: "shell" }
  /** A route package's entry flow (network, token, the deposit). */
  | { kind: "package"; route: FundingRoute }
  /** The journey. `topUpId` opens it as a top-up from the list; without one it reads as a
   *  package handoff. */
  | { kind: "journey"; route: FundingRoute; topUpId?: string }
  /** The withdrawal package's steps, on `#/withdraw` — `app/pages/withdraw.vue` stages the
   *  package of `route` (crypto when unsaid) and the route reads the rest: the step on screen,
   *  the network already picked, the address seeded into the address step, the summary's canned
   *  estimate and fee split, and whether the pickers show their skeletons. The fiat routes read
   *  their own steps and the sale's canned quote instead. */
  | {
      kind: "withdraw-package";
      route?: "crypto" | "card" | "bank";
      step:
        | "network"
        | "token"
        | "address"
        | "summary"
        | "fees"
        | "journey"
        | "return-funds"
        | "quote"
        | "region";
      chain?: string;
      address?: string;
      /** The summary's canned estimate: a string shows it, null shows it quoting, absent hides
       *  the row as an estimate the quote could not give. */
      receive?: string | null;
      fees?: WithdrawFeeView;
      /** A canned secret for the return-funds step, so the revealed frame can be staged. */
      secret?: string;
      skeleton?: boolean;
      /** A fiat route's canned sale: the quote shows it priced, null shows it pricing, and
       *  `saleError` alone shows it refused, the rate after `attempts` failures in a row. The route
       *  never asks the adapter while staged. */
      sale?: MeldSellQuote | null;
      saleError?: { kind: "unrouted" | "rate"; attempts?: number };
      /** The fiat route's payout country, ISO code; GB when unsaid. */
      country?: string;
    };

/**
 * Non-null only while the deck is driving. Always null in a production build — `dev-preview` is
 * its only writer, and the director that calls it is gated on `isDemoBuild()`.
 */
export const previewStage = shallowRef<PreviewStage | null>(null);
