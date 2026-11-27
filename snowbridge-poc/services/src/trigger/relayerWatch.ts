import { getAbiItem, type Address, type PublicClient } from "viem";
import { registryAbi } from "../common/abi";
import type { Logger } from "../common/log";

const RELAYER_CHANGED = getAbiItem({ abi: registryAbi, name: "RelayerChanged" });

// A rotation is logged when it happens, so it is not first noticed as a reverted trigger.
export class RelayerWatch {
  private cursor: bigint;

  constructor(
    private readonly client: PublicClient,
    private readonly registry: Address,
    startBlock: bigint,
    private readonly log: Logger,
  ) {
    this.cursor = startBlock;
  }

  async poll(): Promise<void> {
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    if (head < this.cursor) return;
    const logs = await this.client.getLogs({ address: this.registry, event: RELAYER_CHANGED, fromBlock: this.cursor, toBlock: head });
    this.cursor = head + 1n;
    for (const entry of logs) this.log.info("registry relayer changed", { relayer: entry.args.relayer, block: entry.blockNumber });
  }
}
