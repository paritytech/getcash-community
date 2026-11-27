import { readFileSync } from "node:fs";
import { decodeEventLog, type Abi, type Address, type Hex } from "viem";
import { POOL_ARTIFACT } from "./config";
import { waitFor } from "./chains";
import type { Api } from "./substrate";

export type PoolEvent = {
  name: string;
  args: Record<string, unknown>;
  blockNumber: number;
  blockHash: Hex;
  // The block's own timestamp in milliseconds.
  blockTime: number;
};

export const poolAbi = (): Abi => (JSON.parse(readFileSync(POOL_ARTIFACT, "utf8")) as { abi: Abi }).abi;

// Follows the pool's events block by block from the head at the time it starts.
export class PoolWatcher {
  readonly events: PoolEvent[] = [];
  private cursor = 0;
  private running = false;
  private loop: Promise<void> | undefined;
  private failure: unknown;

  constructor(
    private readonly api: Api,
    private readonly pool: Address,
    private readonly abi: Abi = poolAbi(),
  ) {}

  async start(): Promise<void> {
    this.cursor = await this.finalizedNumber();
    this.running = true;
    this.loop = this.run();
  }

  // Only finalized blocks are read: a fork that loses would otherwise take its events with it after they were scanned.
  private async finalizedNumber(): Promise<number> {
    return (await this.api.rpc.chain.getHeader(await this.api.rpc.chain.getFinalizedHead())).number.toNumber();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  find(name: string, depositId: bigint): PoolEvent | undefined {
    return this.events.find((event) => event.name === name && event.args.depositId === depositId);
  }

  all(name: string, depositId: bigint): PoolEvent[] {
    return this.events.filter((event) => event.name === name && event.args.depositId === depositId);
  }

  async waitFor(name: string, depositId: bigint, timeoutMs: number): Promise<PoolEvent> {
    return waitFor(`pool ${name} of deposit ${depositId}`, async () => {
      if (this.failure) throw this.failure;
      return this.find(name, depositId);
    }, timeoutMs, 1_000);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const head = await this.finalizedNumber();
        for (; this.cursor < head; this.cursor++) await this.scan(this.cursor + 1);
      } catch (error) {
        this.failure = error;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async scan(blockNumber: number): Promise<void> {
    const hash = await this.api.rpc.chain.getBlockHash(blockNumber);
    const at = await this.api.at(hash);
    const records = (await at.query.system.events()) as unknown as {
      event: { section: string; method: string; data: { names?: string[] | null; map<T>(each: (value: { toJSON(): unknown }, index: number) => T): T[] } };
    }[];
    let blockTime: number | undefined;
    for (const { event } of records) {
      if (event.section !== "revive" || event.method !== "ContractEmitted") continue;
      const { contract, data, topics } = Object.fromEntries(event.data.map((value, i) => [event.data.names?.[i] ?? i, value.toJSON()])) as {
        contract: Address;
        data: Hex;
        topics: Hex[];
      };
      if (contract.toLowerCase() !== this.pool.toLowerCase()) continue;
      blockTime ??= Number((await at.query.timestamp.now()).toString());
      try {
        const decoded = decodeEventLog({ abi: this.abi, data, topics: topics as [Hex, ...Hex[]] });
        const { eventName, args } = decoded as unknown as { eventName: string; args: Record<string, unknown> };
        this.events.push({ name: eventName, args, blockNumber, blockHash: hash.toHex(), blockTime });
      } catch {
        // an event the pool ABI does not describe
      }
    }
  }
}
