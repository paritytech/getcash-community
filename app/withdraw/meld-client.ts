// The sell client this withdrawal talks to: the adapter's real one when `VITE_MELD_BASE_URL` is
// configured, the scripted stand-in otherwise. Same selection the buy side makes in
// `app/stores/session.ts`, so a corridor that starts working on the adapter needs no code here to
// change.
//
// In THIS build the real branch is unreachable in practice: DOT_ASSETHUB is not sellable on the
// sandbox account and the adapter's sell routes are only partly built (see the brief this step was
// built from), so every sell runs against `createFakeMeldClient`. It is still wired rather than
// hard-coded to the fake, because the fake client's scripted sell keeps its state on the instance
// that opened the session (see `packages/meld/src/fake.ts`) — the one thing a caller of this
// function must get right either way is using the SAME instance for `createSellSession` and every
// later `getStatus` poll of that sale, never a fresh one.

import {
  createFakeMeldClient,
  createMeldClient,
  type MeldClientLike,
  type MeldSellClientLike,
} from "@getsome/meld";

/** Both halves of the boundary: the sell calls this withdrawal drives itself
 *  (`getSellQuote`/`createSellSession`), and the plain `getStatus`/`cancel` every poll and the
 *  cancel affordance need too. */
export function meldSellClient(): MeldClientLike & MeldSellClientLike {
  const baseUrl = import.meta.env.VITE_MELD_BASE_URL as string | undefined;
  return baseUrl
    ? createMeldClient({
        baseUrl,
        productId: (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
      })
    : createFakeMeldClient();
}
