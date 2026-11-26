// A small Ethereum JSON-RPC client over fetch. The reads serve the checks of the bridge routes.
// The nonce, the fees, the send and the receipt serve the transactions getcash signs itself, which
// it does on purpose so that a top-up needs no forwarder contract and no relayer.
// TODO: remove the nonce, the fees, the send and the receipt once a forwarder and a relayer send
// the transactions.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** The part of fetch this client uses. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The node answered with an error of its own, as it does for a call that reverts. */
export class EvmRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    /** What the node attached to the error: for a revert, the bytes it reverted with. */
    readonly data?: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "EvmRpcError";
  }
}

/** The node did not answer, or answered with something that is not a JSON-RPC reply. */
export class EvmRpcUnreachable extends Error {
  constructor(
    readonly method: string,
    reason: string,
  ) {
    super(`${method}: ${reason}`);
    this.name = "EvmRpcUnreachable";
  }
}

/** A call to simulate or to estimate. */
export interface EvmCall {
  to: string;
  data?: Uint8Array;
  from?: string;
  value?: bigint;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: Uint8Array;
}

export interface EvmReceipt {
  /** The transaction ran to its end. False when it reverted. */
  succeeded: boolean;
  blockNumber: bigint;
  gasUsed: bigint;
  logs: EvmLog[];
}

export interface EvmRpc {
  chainId(): Promise<bigint>;
  balance(address: string): Promise<bigint>;
  /** The nonce the account's next transaction takes, counting the ones still pending. */
  nonce(address: string): Promise<bigint>;
  /** Runs `call` at the latest block without sending it, and returns what it returned. */
  call(call: EvmCall): Promise<Uint8Array>;
  estimateGas(call: EvmCall): Promise<bigint>;
  /** The base fee of the latest block. */
  baseFee(): Promise<bigint>;
  /** The tip the node suggests. */
  priorityFee(): Promise<bigint>;
  /** Sends a signed transaction and returns its hash. */
  send(raw: Uint8Array): Promise<string>;
  /** The receipt of a transaction, or null while it is in no block. */
  receipt(hash: string): Promise<EvmReceipt | null>;
}

const toHex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;
const quantity = (value: bigint): string => `0x${value.toString(16)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The client for the node at `url`. */
export function createEvmRpc(
  url: string,
  fetchImpl: FetchLike = (target, init) => fetch(target, init),
): EvmRpc {
  let nextId = 1;

  async function request(method: string, params: unknown[]): Promise<unknown> {
    let body: unknown;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (cause) {
      throw new EvmRpcUnreachable(method, cause instanceof Error ? cause.message : String(cause));
    }
    if (!isRecord(body)) throw new EvmRpcUnreachable(method, "the reply is not an object");
    const { error } = body;
    if (isRecord(error)) {
      throw new EvmRpcError(
        method,
        typeof error.code === "number" ? error.code : undefined,
        typeof error.message === "string" ? error.message : "the node gave no message",
        typeof error.data === "string" ? error.data : undefined,
      );
    }
    if (!("result" in body)) throw new EvmRpcUnreachable(method, "the reply has no result");
    return body.result;
  }

  const hexOf = (method: string, value: unknown): string => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
      throw new EvmRpcUnreachable(method, "the reply is not hex");
    }
    return value;
  };
  const numberOf = (method: string, value: unknown): bigint => {
    const hex = hexOf(method, value);
    if (hex === "0x") throw new EvmRpcUnreachable(method, "the reply is an empty number");
    return BigInt(hex);
  };
  const bytesOf = (method: string, value: unknown): Uint8Array => {
    const hex = hexOf(method, value);
    if (hex.length % 2 !== 0) throw new EvmRpcUnreachable(method, "the reply is half a byte");
    return hexToBytes(hex.slice(2));
  };

  const callObject = (call: EvmCall) => ({
    to: call.to,
    ...(call.from === undefined ? {} : { from: call.from }),
    ...(call.data === undefined ? {} : { data: toHex(call.data) }),
    ...(call.value === undefined ? {} : { value: quantity(call.value) }),
  });

  const quantityOf = async (method: string, params: unknown[]): Promise<bigint> =>
    numberOf(method, await request(method, params));

  return {
    chainId: () => quantityOf("eth_chainId", []),
    balance: (address) => quantityOf("eth_getBalance", [address, "latest"]),
    nonce: (address) => quantityOf("eth_getTransactionCount", [address, "pending"]),
    call: async (call) =>
      bytesOf("eth_call", await request("eth_call", [callObject(call), "latest"])),
    estimateGas: (call) => quantityOf("eth_estimateGas", [callObject(call)]),
    async baseFee() {
      const method = "eth_getBlockByNumber";
      const block = await request(method, ["latest", false]);
      if (!isRecord(block)) throw new EvmRpcUnreachable(method, "the node has no latest block");
      return numberOf(method, block.baseFeePerGas);
    },
    priorityFee: () => quantityOf("eth_maxPriorityFeePerGas", []),
    async send(raw) {
      const method = "eth_sendRawTransaction";
      return hexOf(method, await request(method, [toHex(raw)]));
    },
    async receipt(hash) {
      const method = "eth_getTransactionReceipt";
      const found = await request(method, [hash]);
      if (found === null) return null;
      if (!isRecord(found)) throw new EvmRpcUnreachable(method, "the receipt is not an object");
      if (!Array.isArray(found.logs)) {
        throw new EvmRpcUnreachable(method, "the receipt has no logs");
      }
      return {
        succeeded: numberOf(method, found.status) === 1n,
        blockNumber: numberOf(method, found.blockNumber),
        gasUsed: numberOf(method, found.gasUsed),
        logs: found.logs.map((log: unknown) => {
          if (!isRecord(log) || !Array.isArray(log.topics)) {
            throw new EvmRpcUnreachable(method, "a log is not an object with topics");
          }
          return {
            address: hexOf(method, log.address),
            topics: log.topics.map((topic) => hexOf(method, topic)),
            data: bytesOf(method, log.data),
          };
        }),
      };
    },
  };
}
