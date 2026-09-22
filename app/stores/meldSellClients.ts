// One Meld sell client per withdrawal, kept for the app session's lifetime — the withdrawal
// side's counterpart to the buy side's own `meldStatusClient` on `useSessionStore`, which
// survives navigation because a Pinia store is a singleton for as long as the app runs, not
// recreated on every component mount the way a local composable's state is.
//
// This matters beyond tidiness: the fake client's scripted sell keeps its progress on the
// instance that opened the session (see `packages/meld/src/fake.ts` — the state lives in a
// closure over that one object, nothing server-side to fall back on). A component that built a
// fresh client on every mount would lose that progress every time the seller left the KYC screen
// and came back, not only across a reload. Keying by the withdrawal's own request-ref string
// keeps this correct even with several sales open across different sourceIds.

import { defineStore } from "pinia";
import type { MeldClientLike, MeldSellClientLike } from "@getsome/meld";
import { meldSellClient } from "../withdraw/meld-client";

export const useMeldSellClients = defineStore("meld-sell-clients", () => {
  const clients = new Map<string, MeldClientLike & MeldSellClientLike>();

  /** The client for `key` (a request-ref string), building one the first time it is asked for. */
  function clientFor(key: string): MeldClientLike & MeldSellClientLike {
    let client = clients.get(key);
    if (client === undefined) {
      client = meldSellClient();
      clients.set(key, client);
    }
    return client;
  }

  /** Drops a sale's client once it is done and nothing will poll or resume it again. Not required
   *  for correctness — an abandoned entry is just a little memory for the rest of the session —
   *  but there is no reason to keep it once the sale can no longer move. */
  function forget(key: string): void {
    clients.delete(key);
  }

  return { clientFor, forget };
});
