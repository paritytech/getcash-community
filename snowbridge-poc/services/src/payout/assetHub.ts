import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { u8aToHex } from "@polkadot/util";
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isAddressEqual,
  keccak256,
  bytesToHex,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { poolAbi } from "./abi";
import type { AssetHubClient, DepositKey, FrontOutcome, FrontRequest, PoolDeposit, PoolParams, SettledEvent, SettledScan } from "./types";

type ViewName = "BRIDGE_FEE" | "FRONT_FEE_CAP_BPS" | "state" | "funds";

type DryCall = { reverted: boolean; output: Hex; weight: { refTime: bigint; proofSize: bigint }; storageDeposit: bigint };

type EventRecord = {
  section: string;
  method: string;
  data: { names?: string[] | null; map<T>(each: (value: { toJSON(): unknown }, index: number) => T): T[] };
};

type Extrinsic = ReturnType<ApiPromise["tx"]["revive"]["call"]>;

type Included = { blockHash: Hex; extrinsicHash: Hex };

export type ClientOptions = { submitTimeoutMs?: number };

const MAX_SUBMISSIONS = 3;
const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;
const SETTLED_TOPIC = toEventSelector("Settled(uint256,bool,address,uint256)");
// Same margin as assethub's `submitCall`.
const MARGIN_NUM = 13n;
const MARGIN_DEN = 10n;
const DEPOSIT_HEADROOM = 1_000_000_000n;

// The chain state of a submission is unknown, so callers read it again before acting.
export class TransportError extends Error {}

export class PolkadotAssetHubClient implements AssetHubClient {
  readonly payer: Address;
  private readonly origin: Hex;
  private readonly submitTimeoutMs: number;

  private constructor(
    private readonly api: ApiPromise,
    private readonly signer: KeyringPair,
    private readonly pool: Address,
    options: ClientOptions,
  ) {
    this.origin = u8aToHex(signer.publicKey);
    this.payer = reviveAddress(this.origin);
    this.submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  }

  // `seed` is a 0x-prefixed 32-byte hex seed or a substrate URI; the payer's account is derived with sr25519.
  static async connect(url: string, seed: string, pool: Address, options: ClientOptions = {}): Promise<PolkadotAssetHubClient> {
    const api = await ApiPromise.create({ provider: new WsProvider(url), noInitWarn: true });
    return new PolkadotAssetHubClient(api, new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(seed), pool, options);
  }

  static withApi(api: ApiPromise, signer: KeyringPair, pool: Address, options: ClientOptions = {}): PolkadotAssetHubClient {
    return new PolkadotAssetHubClient(api, signer, pool, options);
  }

  close(): Promise<void> {
    return this.api.disconnect();
  }

  async poolParams(): Promise<PoolParams> {
    const [bridgeFee, capBps] = await Promise.all([this.view("BRIDGE_FEE", []), this.view("FRONT_FEE_CAP_BPS", [])]);
    return { bridgeFee: bridgeFee as bigint, capBps: Number(capBps) };
  }

  // The finalized head: events are only read from blocks that cannot be replaced by a fork.
  async blockNumber(): Promise<number> {
    const finalized = await this.api.rpc.chain.getFinalizedHead();
    return (await this.api.rpc.chain.getHeader(finalized)).number.toNumber();
  }

  async deposit({ depositId, account, token, amount }: DepositKey): Promise<PoolDeposit> {
    const [status, payer] = (await this.view("state", [depositId, account, token, amount])) as readonly [number, Address];
    return { status: Number(status), payer: getAddress(payer) };
  }

  async funds(token: Address): Promise<bigint> {
    return (await this.view("funds", [this.payer, token])) as bigint;
  }

  async front({ depositId, account, token, amount, fee }: FrontRequest, signal?: AbortSignal): Promise<FrontOutcome> {
    const data = encodeFunctionData({ abi: poolAbi, functionName: "front", args: [depositId, account, token, amount, fee] });
    const dry = await this.dryRun(data);
    if (dry.kind === "failed") return { kind: "reverted", reason: dry.reason };
    if (dry.call.reverted) return { kind: "reverted", ...describeRevert(dry.call.output) };

    const weight = { refTime: (dry.call.weight.refTime * MARGIN_NUM) / MARGIN_DEN, proofSize: (dry.call.weight.proofSize * MARGIN_NUM) / MARGIN_DEN };
    const depositLimit = (dry.call.storageDeposit * MARGIN_NUM) / MARGIN_DEN + DEPOSIT_HEADROOM;
    try {
      const included = await this.submitWithRetry(() => this.api.tx.revive!.call!(this.pool, 0, weight, depositLimit, data), signal);
      return { kind: "included", ...included };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ContractReverted")) throw error;
      // The state changed between the simulation and the inclusion; simulating again names the error, such as a stranger's front.
      const again = await this.dryRun(data);
      if (again.kind === "ok" && again.call.reverted) return { kind: "reverted", ...describeRevert(again.call.output) };
      return { kind: "reverted", reason: error.message };
    }
  }

  async settledEvents(fromBlock: number, toBlock: number): Promise<SettledScan> {
    const events: SettledEvent[] = [];
    const prunedBlocks: number[] = [];
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
      const hash = await this.api.rpc.chain.getBlockHash(blockNumber);
      let records: { event: EventRecord }[];
      try {
        records = (await (await this.api.at(hash)).query.system!.events!()) as unknown as { event: EventRecord }[];
      } catch (error) {
        // Retrying a pruned block would wedge the follower, so it is reported and skipped.
        if (!(error instanceof Error) || !error.message.includes("State already discarded")) throw error;
        prunedBlocks.push(blockNumber);
        continue;
      }
      for (const { event } of records) {
        const settled = this.decodeSettled(event, blockNumber, hash.toHex());
        if (settled) events.push(settled);
      }
    }
    return { events, prunedBlocks };
  }

  private decodeSettled(event: EventRecord, blockNumber: number, blockHash: Hex): SettledEvent | undefined {
    if (event.section !== "revive" || event.method !== "ContractEmitted") return undefined;
    const { contract, data, topics } = Object.fromEntries(event.data.map((value, i) => [event.data.names?.[i] ?? i, value.toJSON()])) as {
      contract: Address;
      data: Hex;
      topics: Hex[];
    };
    if (!isAddressEqual(contract, this.pool) || topics[0] !== SETTLED_TOPIC) return undefined;
    const { args } = decodeEventLog({ abi: poolAbi, eventName: "Settled", data, topics: topics as [Hex, ...Hex[]] });
    return { depositId: args.depositId, repaid: args.repaid, to: getAddress(args.to), amount: args.amount, blockNumber, blockHash };
  }

  private async view(functionName: ViewName, args: readonly unknown[]): Promise<unknown> {
    const data = encodeFunctionData({ abi: poolAbi, functionName, args } as never);
    const dry = await this.dryRun(data);
    if (dry.kind === "failed") throw new Error(`${functionName} failed: ${dry.reason}`);
    if (dry.call.reverted) throw new Error(`${functionName} reverted: ${describeRevert(dry.call.output).reason}`);
    return decodeFunctionResult({ abi: poolAbi, functionName, data: dry.call.output } as never);
  }

  // A transport failure throws; an error the runtime reports for the call itself comes back as `failed`.
  private async dryRun(data: Hex): Promise<{ kind: "ok"; call: DryCall } | { kind: "failed"; reason: string }> {
    const result = (await this.api.call.reviveApi!.call!(this.origin, this.pool, 0, null, null, data)).toJSON() as {
      weightRequired: { refTime: number; proofSize: number };
      maxStorageDeposit: { charge?: number | string };
      result: { ok?: { flags: { bits: number }; data: Hex }; err?: unknown };
    };
    if (!result.result.ok) return { kind: "failed", reason: `call failed: ${JSON.stringify(result.result.err)}` };
    return {
      kind: "ok",
      call: {
        reverted: result.result.ok.flags.bits !== 0,
        output: result.result.ok.data,
        weight: { refTime: BigInt(result.weightRequired.refTime), proofSize: BigInt(result.weightRequired.proofSize) },
        storageDeposit: BigInt(result.maxStorageDeposit.charge ?? 0),
      },
    };
  }

  // The pool rejects a transaction whose birth block was on a fork that lost; it was never included, so signing it again is safe.
  private async submitWithRetry(build: () => Extrinsic, signal?: AbortSignal): Promise<Included> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.signAndWait(build(), signal);
      } catch (error) {
        if (attempt >= MAX_SUBMISSIONS || !(error instanceof Error) || !error.message.startsWith("extrinsic rejected")) throw error;
      }
    }
  }

  // polkadot-js does not re-create `author_*` subscriptions after a reconnect, so a dropped socket would leave this waiting forever.
  private signAndWait(tx: Extrinsic, signal?: AbortSignal): Promise<Included> {
    return new Promise((resolve, reject) => {
      let finished = false;
      let unsubscribe: (() => void) | undefined;

      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.api.off("disconnected", onDisconnect);
        signal?.removeEventListener("abort", onAbort);
        unsubscribe?.();
        settle();
      };
      const timer = setTimeout(
        () => finish(() => reject(new TransportError(`front submission timed out after ${this.submitTimeoutMs} ms; the extrinsic may still land`))),
        this.submitTimeoutMs,
      );
      const onDisconnect = () => finish(() => reject(new TransportError("the Asset Hub connection dropped during the front; the extrinsic may still land")));
      const onAbort = () => finish(() => reject(new TransportError("front submission aborted; the extrinsic may still land")));
      this.api.on("disconnected", onDisconnect);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      tx.signAndSend(this.signer, (result) => {
        if (result.dispatchError) {
          const { dispatchError } = result;
          const meta = dispatchError.isModule ? this.api.registry.findMetaError(dispatchError.asModule) : undefined;
          finish(() => reject(new Error(`dispatch failed: ${meta ? `${meta.section}.${meta.name}` : dispatchError.toString()}`)));
        } else if (result.isInBlock) {
          finish(() => resolve({ blockHash: result.status.asInBlock.toHex(), extrinsicHash: result.txHash.toHex() }));
        } else if (result.isError) {
          finish(() => reject(new Error(`extrinsic rejected: ${result.status.toString()}`)));
        }
      }).then(
        (stop) => {
          unsubscribe = stop;
          if (finished) stop();
        },
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}

// Mirrors pallet-revive's `AccountId32Mapper::to_address`: an account ending in twelve 0xEE bytes drops them, any other is hashed.
function reviveAddress(account: Hex): Address {
  const bytes = hexToBytes(account);
  if (bytes.subarray(20).every((byte) => byte === 0xee)) return getAddress(bytesToHex(bytes.subarray(0, 20)));
  return getAddress(`0x${keccak256(account).slice(26)}`);
}

function describeRevert(output: Hex): { reason: string; error?: string } {
  try {
    const decoded = decodeErrorResult({ abi: poolAbi, data: output });
    return { reason: `${decoded.errorName}${decoded.args?.length ? `(${decoded.args.join(", ")})` : ""}`, error: decoded.errorName };
  } catch {
    return { reason: output === "0x" ? "reverted without data" : `reverted with ${output.slice(0, 74)}` };
  }
}
