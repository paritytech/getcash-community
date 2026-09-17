// Finds what Asset Hub's message queue did with a message: walks the blocks since the submit and
// reads each block's events for the queue's Processed event with the message's id.

import type { PolkadotClient } from "polkadot-api";
import type { AssetHubApi } from "./fees";
import type { MessageOutcome } from "./tick";

/** Blocks read in one search, so a tick stays bounded however long the message takes. */
export const MESSAGE_SEARCH_SPAN = 60;

/** A searcher over Asset Hub for the tick's `findMessageOutcome`. */
export function createMessageWatcher(client: PolkadotClient, api: AssetHubApi) {
  return async function findMessageOutcome(
    messageId: string,
    fromBlock: number,
  ): Promise<{ outcome: MessageOutcome; scannedTo: number }> {
    const head = await client.getFinalizedBlock();
    const last = Math.min(head.number, fromBlock + MESSAGE_SEARCH_SPAN - 1);
    const wanted = messageId.toLowerCase();
    for (let n = fromBlock; n <= last; n += 1) {
      const hash = await client._request<string>("chain_getBlockHash", [n]);
      const events = await api.query.System.Events.getValue({ at: hash });
      for (const { event } of events) {
        if (event.type !== "MessageQueue" || event.value.type !== "Processed") continue;
        const { id, success } = event.value.value as { id: string; success: boolean };
        if (id.toLowerCase() === wanted) return { outcome: { success, block: n }, scannedTo: n };
      }
    }
    return { outcome: null, scannedTo: Math.max(last, fromBlock - 1) };
  };
}
