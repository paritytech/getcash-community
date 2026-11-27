import type { ApiPromise } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { poolAbi } from "../../src/payout/abi";
import { PolkadotAssetHubClient, type ClientOptions } from "../../src/payout/assetHub";

export const POOL: Address = getAddress(`0x${"ab".repeat(20)}`);
export const NOT_POOL: Address = getAddress(`0x${"cd".repeat(20)}`);

type Callback = (result: Record<string, unknown>) => void;

// What one submission does once it is signed: it drives the callback the way the node's status stream would.
export type Submission = (callback: Callback) => void;

export const included = (blockHash: Hex = `0x${"b1".repeat(32)}`, txHash: Hex = `0x${"c2".repeat(32)}`): Submission => (callback) =>
  callback({
    isInBlock: true,
    isError: false,
    status: { asInBlock: { toHex: () => blockHash }, toString: () => "InBlock" },
    txHash: { toHex: () => txHash },
  });

export const rejected = (status = "Invalid"): Submission => (callback) =>
  callback({ isInBlock: false, isError: true, status: { toString: () => status } });

export const dispatchFailed = (name: string): Submission => (callback) =>
  callback({ dispatchError: { isModule: true, asModule: { name }, toString: () => name }, isInBlock: false, isError: false });

export const silent: Submission = () => undefined;

type RawEvent = { section: string; method: string; values: { name: string; value: unknown }[] };

export const contractEmitted = (contract: Address, topics: Hex[], data: Hex): RawEvent => ({
  section: "revive",
  method: "ContractEmitted",
  values: [
    { name: "contract", value: contract },
    { name: "data", value: data },
    { name: "topics", value: topics },
  ],
});

export const settledLog = (depositId: bigint, repaid: boolean, to: Address, amount: bigint) => ({
  topics: encodeEventTopics({ abi: poolAbi, eventName: "Settled", args: { depositId } }) as Hex[],
  data: encodeAbiParameters([{ type: "bool" }, { type: "address" }, { type: "uint256" }], [repaid, to, amount]),
});

export const revertData = (errorName: "AlreadyFronted" | "AlreadySettled" | "InsufficientFunds"): Hex => encodeErrorResult({ abi: poolAbi, errorName });

export type DryRun = { reverted?: boolean; output?: Hex; err?: unknown };

export class FakeApi {
  finalized = 1_000;
  events = new Map<number, RawEvent[] | Error>();
  submissions: Submission[] = [];
  submitted = 0;
  onSubmit: (() => void) | undefined;
  unsubscribed = 0;
  dryRuns: { functionName: string; args: readonly unknown[] }[] = [];
  state: { status: number; payer: Address } = { status: 0, payer: "0x0000000000000000000000000000000000000000" };
  funds = 10n ** 24n;
  // Overrides what the front call's simulation says, for one call at a time.
  frontDryRuns: DryRun[] = [];
  private listeners = new Map<string, Set<() => void>>();
  disconnected = false;

  rpc = {
    chain: {
      getFinalizedHead: async () => `0x${"f0".repeat(32)}`,
      getHeader: async () => ({ number: { toNumber: () => this.finalized } }),
      getBlockHash: async (number: number) => ({ toHex: () => `0x${number.toString(16).padStart(64, "0")}` as Hex }),
    },
  };

  registry = { findMetaError: ({ name }: { name: string }) => ({ section: "revive", name }) };

  call = {
    reviveApi: {
      call: async (_origin: Hex, _pool: Address, _value: number, _weight: null, _limit: null, data: Hex) => {
        const { functionName, args } = decodeFunctionData({ abi: poolAbi, data });
        this.dryRuns.push({ functionName, args: args ?? [] });
        return { toJSON: () => this.dryRunResult(functionName) };
      },
    },
  };

  tx = {
    revive: {
      call: () => ({
        signAndSend: async (_signer: unknown, callback: Callback) => {
          this.submitted++;
          this.onSubmit?.();
          const behave = this.submissions.shift();
          if (!behave) throw new Error("no submission scripted");
          queueMicrotask(() => behave(callback));
          return () => void this.unsubscribed++;
        },
      }),
    },
  };

  at = async (hash: { toHex(): Hex }) => {
    const number = Number(BigInt(hash.toHex()));
    return {
      query: {
        system: {
          events: async () => {
            const found = this.events.get(number);
            if (found instanceof Error) throw found;
            return (found ?? []).map((raw) => ({
              event: {
                section: raw.section,
                method: raw.method,
                data: {
                  names: raw.values.map((entry) => entry.name),
                  map: <T>(each: (value: { toJSON(): unknown }, index: number) => T) => raw.values.map((entry, index) => each({ toJSON: () => entry.value }, index)),
                },
              },
            }));
          },
        },
      },
    };
  };

  on = (event: string, listener: () => void) => {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  };

  off = (event: string, listener: () => void) => {
    this.listeners.get(event)?.delete(listener);
    return this;
  };

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  disconnect = async () => void (this.disconnected = true);

  private dryRunResult(functionName: string) {
    const weightRequired = { refTime: 1_000, proofSize: 100 };
    const maxStorageDeposit = { charge: 10 };
    const ok = (output: Hex, reverted = false) => ({ weightRequired, maxStorageDeposit, result: { ok: { flags: { bits: reverted ? 1 : 0 }, data: output } } });

    if (functionName === "state") {
      return ok(encodeFunctionResult({ abi: poolAbi, functionName: "state", result: [this.state.status, this.state.payer] }));
    }
    if (functionName === "funds") return ok(encodeFunctionResult({ abi: poolAbi, functionName: "funds", result: this.funds }));
    if (functionName === "BRIDGE_FEE") return ok(encodeFunctionResult({ abi: poolAbi, functionName: "BRIDGE_FEE", result: 10n ** 15n }));
    if (functionName === "FRONT_FEE_CAP_BPS") return ok(encodeFunctionResult({ abi: poolAbi, functionName: "FRONT_FEE_CAP_BPS", result: 100 }));

    const scripted = this.frontDryRuns.shift() ?? {};
    if (scripted.err !== undefined) return { weightRequired, maxStorageDeposit, result: { err: scripted.err } };
    return ok(scripted.output ?? "0x", scripted.reverted);
  }
}

export async function newClient(api: FakeApi, options: ClientOptions = {}, uri = "//Alice") {
  await cryptoWaitReady();
  const signer = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(uri);
  return PolkadotAssetHubClient.withApi(api as unknown as ApiPromise, signer, POOL, options);
}
