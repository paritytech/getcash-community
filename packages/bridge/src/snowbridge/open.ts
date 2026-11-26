// Whether Snowbridge takes a message now. Three parts can be stopped by its governance: the
// Gateway on Ethereum, and on Bridge Hub the client that follows Ethereum and the queue that
// takes the messages.

import { encodeCall, wordAt } from "../evm-abi";
import type { EvmRpc } from "../evm-rpc";
import { SnowbridgeReadError, type ChainReader } from "./chain";
import { SNOWBRIDGE_GATEWAY } from "./message";

/** True when a part of Bridge Hub says it is halted. */
function halted(mode: unknown, what: string): boolean {
  const type = typeof mode === "object" && mode !== null ? (mode as { type?: unknown }).type : null;
  if (type === "Normal") return false;
  if (type === "Halted") return true;
  throw new SnowbridgeReadError(`${what} gave no operating mode`);
}

/** Why Snowbridge takes no message now, or null when it does. */
export async function snowbridgeRefusal(
  ethereum: Pick<EvmRpc, "call">,
  bridgeHub: ChainReader,
): Promise<string | null> {
  const [gateway, client, queue] = await Promise.all([
    ethereum.call({ to: SNOWBRIDGE_GATEWAY, data: encodeCall("operatingMode()") }),
    bridgeHub.storage("EthereumBeaconClient", "OperatingMode"),
    bridgeHub.storage("EthereumInboundQueueV2", "OperatingMode"),
  ]);
  if (wordAt(gateway, 0) !== 0n) return "the Gateway takes no messages now";
  if (halted(client, "Bridge Hub's Ethereum client")) {
    return "Bridge Hub's Ethereum client is halted";
  }
  if (halted(queue, "Bridge Hub's queue")) return "Bridge Hub's queue for Ethereum is halted";
  return null;
}
