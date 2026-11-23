// The Ethereum client over a scripted fetch: what it asks the node, how it reads the answers, and
// which error each kind of bad answer becomes.

import { describe, expect, it } from "vitest";
import { createEvmRpc, EvmRpcError, EvmRpcUnreachable, type FetchLike } from "./evm-rpc";

const URL = "https://node.example";
const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const HASH = "0xb18cb061195bfb577ef4f608f162bd88a09989cbbaa34ee7e647d4ce468d93f3";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
}

/** A node that answers every request with `reply`, and the requests it was sent. */
function node(reply: unknown, http: { ok?: boolean; status?: number } = {}) {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: http.ok ?? true, status: http.status ?? 200, json: async () => reply };
  };
  return { rpc: createEvmRpc(URL, fetchImpl), sent };
}

const result = (value: unknown) => ({ jsonrpc: "2.0", id: 1, result: value });

describe("createEvmRpc, the requests", () => {
  it("posts JSON-RPC to the node's address, with a new id each time", async () => {
    const { rpc, sent } = node(result("0x1"));
    await rpc.chainId();
    await rpc.chainId();
    expect(sent[0]).toEqual({
      url: URL,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    });
    expect(sent[1]?.body.id).toBe(2);
  });

  it.each<[string, (rpc: ReturnType<typeof createEvmRpc>) => Promise<unknown>, string, unknown[]]>([
    ["the balance", (rpc) => rpc.balance(ACCOUNT), "eth_getBalance", [ACCOUNT, "latest"]],
    [
      "the nonce, with pending transactions counted",
      (rpc) => rpc.nonce(ACCOUNT),
      "eth_getTransactionCount",
      [ACCOUNT, "pending"],
    ],
    ["the suggested tip", (rpc) => rpc.priorityFee(), "eth_maxPriorityFeePerGas", []],
    [
      "a gas estimate, with every field of the call",
      (rpc) =>
        rpc.estimateGas({
          to: ACCOUNT,
          from: ACCOUNT,
          data: Uint8Array.of(0xab, 0x01),
          value: 255n,
        }),
      "eth_estimateGas",
      [{ to: ACCOUNT, from: ACCOUNT, data: "0xab01", value: "0xff" }],
    ],
  ])("asks for %s", async (_name, ask, method, params) => {
    const { rpc, sent } = node(result("0x10"));
    expect(await ask(rpc)).toBe(16n);
    expect(sent[0]?.body.method).toBe(method);
    expect(sent[0]?.body.params).toEqual(params);
  });

  it("simulates a call at the latest block and leaves out the fields it was not given", async () => {
    const { rpc, sent } = node(result("0x0001ff"));
    expect(await rpc.call({ to: ACCOUNT })).toEqual(Uint8Array.of(0x00, 0x01, 0xff));
    expect(sent[0]?.body).toMatchObject({
      method: "eth_call",
      params: [{ to: ACCOUNT }, "latest"],
    });
  });

  it("reads an empty return as no bytes", async () => {
    const { rpc } = node(result("0x"));
    expect(await rpc.call({ to: ACCOUNT })).toEqual(new Uint8Array(0));
  });

  it("reads the base fee from the latest block", async () => {
    const { rpc, sent } = node(result({ number: "0x10", baseFeePerGas: "0x3b9aca00" }));
    expect(await rpc.baseFee()).toBe(1_000_000_000n);
    expect(sent[0]?.body).toMatchObject({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
  });

  it("sends the signed bytes as hex and returns the hash", async () => {
    const { rpc, sent } = node(result(HASH));
    expect(await rpc.send(Uint8Array.of(0x02, 0xf8, 0x73))).toBe(HASH);
    expect(sent[0]?.body).toMatchObject({ method: "eth_sendRawTransaction", params: ["0x02f873"] });
  });
});

describe("createEvmRpc, the receipt", () => {
  const receipt = {
    status: "0x1",
    blockNumber: "0x20",
    gasUsed: "0x5208",
    logs: [{ address: ACCOUNT, topics: [HASH], data: "0xdead" }],
  };

  it("is null while the transaction is in no block", async () => {
    const { rpc, sent } = node(result(null));
    expect(await rpc.receipt(HASH)).toBeNull();
    expect(sent[0]?.body).toMatchObject({ method: "eth_getTransactionReceipt", params: [HASH] });
  });

  it("reads a transaction that ran to its end, with its logs", async () => {
    const { rpc } = node(result(receipt));
    expect(await rpc.receipt(HASH)).toEqual({
      succeeded: true,
      blockNumber: 32n,
      gasUsed: 21_000n,
      logs: [{ address: ACCOUNT, topics: [HASH], data: Uint8Array.of(0xde, 0xad) }],
    });
  });

  it("reads a transaction that reverted", async () => {
    const { rpc } = node(result({ ...receipt, status: "0x0", logs: [] }));
    expect(await rpc.receipt(HASH)).toMatchObject({ succeeded: false, logs: [] });
  });

  it.each<[string, unknown]>([
    ["has no logs", { ...receipt, logs: undefined }],
    ["has no status", { ...receipt, status: undefined }],
    ["is not an object", "0x1"],
    ["has a log with no topics", { ...receipt, logs: [{ address: ACCOUNT, data: "0x" }] }],
    [
      "has a log with half a byte of data",
      { ...receipt, logs: [{ ...receipt.logs[0], data: "0xabc" }] },
    ],
  ])("does not trust a receipt that %s", async (_name, bad) => {
    const { rpc } = node(result(bad));
    await expect(rpc.receipt(HASH)).rejects.toBeInstanceOf(EvmRpcUnreachable);
  });
});

describe("createEvmRpc, the errors", () => {
  it("gives the node's own error with its code and data", async () => {
    const { rpc } = node({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 3, message: "execution reverted", data: "0x479ef3f7" },
    });
    const error = await rpc.call({ to: ACCOUNT }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvmRpcError);
    expect(error).toMatchObject({
      method: "eth_call",
      code: 3,
      data: "0x479ef3f7",
      message: "eth_call: execution reverted",
    });
  });

  it("gives the node's error even when it has no code, message or data", async () => {
    const { rpc } = node({ jsonrpc: "2.0", id: 1, error: {} });
    const error = await rpc.chainId().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvmRpcError);
    expect(error).toMatchObject({ code: undefined, data: undefined });
  });

  it.each<[string, unknown, { ok?: boolean; status?: number }, string]>([
    ["an HTTP error", result("0x1"), { ok: false, status: 503 }, "HTTP 503"],
    ["a reply that is not an object", "nothing", {}, "not an object"],
    ["a reply with no result", { jsonrpc: "2.0", id: 1 }, {}, "no result"],
    ["a result that is not hex", result("12"), {}, "not hex"],
    ["a result that is not a string", result(12), {}, "not hex"],
    ["an empty number", result("0x"), {}, "empty number"],
  ])("treats %s as a node that did not answer", async (_name, reply, http, reason) => {
    const { rpc } = node(reply, http);
    const error = await rpc.chainId().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvmRpcUnreachable);
    expect((error as Error).message).toContain(reason);
  });

  it("treats a fetch that throws as a node that did not answer", async () => {
    const rpc = createEvmRpc(URL, async () => {
      throw new Error("network down");
    });
    const error = await rpc.balance(ACCOUNT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvmRpcUnreachable);
    expect((error as Error).message).toBe("eth_getBalance: network down");
  });

  it("treats a body that is not JSON as a node that did not answer", async () => {
    const rpc = createEvmRpc(URL, async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    await expect(rpc.chainId()).rejects.toBeInstanceOf(EvmRpcUnreachable);
  });

  it("treats a block with no base fee as a node that did not answer", async () => {
    const { rpc } = node(result({ number: "0x10" }));
    await expect(rpc.baseFee()).rejects.toBeInstanceOf(EvmRpcUnreachable);
    const none = node(result(null));
    await expect(none.rpc.baseFee()).rejects.toBeInstanceOf(EvmRpcUnreachable);
  });

  it("treats half a byte of returned data as a node that did not answer", async () => {
    const { rpc } = node(result("0xabc"));
    await expect(rpc.call({ to: ACCOUNT })).rejects.toBeInstanceOf(EvmRpcUnreachable);
  });
});
