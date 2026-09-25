// Where the preview deck wants the shell while a scene is on screen.
//
// A scene only writes store state; the shell's containers are its own. Cycling a scene that
// belongs to a package or the journey while the list has the screen (or the other way round) left
// the state unread and the screen unchanged, so the deck looked stuck. The scene names it wants
// here, and `app/pages/index.vue` puts it there before the scene's state is applied.

import { shallowRef } from "vue";
import type { FundingRoute } from "../funding/selection";

export type PreviewStage =
  /** The shell's own screens: the top-ups list, history, the amount screen. */
  | { kind: "shell" }
  /** A route package's entry flow (network, token, the deposit). */
  | { kind: "package"; route: FundingRoute }
  /** The journey. `topUpId` opens it as a top-up from the list; without one it reads as a
   *  package handoff. */
  | { kind: "journey"; route: FundingRoute; topUpId?: string }
  /** The withdrawal package's pickers and address, on `#/withdraw` — `app/pages/withdraw.vue`
   *  stages the package and the route reads the rest: the step on screen, the network already
   *  picked, the address seeded into the address step, and whether the pickers show their
   *  skeletons. */
  | {
      kind: "withdraw-package";
      step: "network" | "token" | "address";
      chain?: string;
      address?: string;
      skeleton?: boolean;
    };

/**
 * Non-null only while the deck is driving. Always null in a production build — `dev-preview` is
 * its only writer, and the director that calls it is gated on `isDemoBuild()`.
 */
export const previewStage = shallowRef<PreviewStage | null>(null);
