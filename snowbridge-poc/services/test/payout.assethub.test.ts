import { describe, expect, it } from "vitest";
import { getAddress, toEventSelector, type Address } from "viem";
import { DepositStatus } from "../src/payout/abi";
import { TransportError } from "../src/payout/assetHub";
import {
  FakeApi,
  NOT_POOL,
  POOL,
  contractEmitted,
  dispatchFailed,
  included,
  newClient,
  rejected,
  revertData,
  settledLog,
  silent,
} from "./helpers/fakeApi";

const request = { depositId: 7n, account: `0x${"ab".repeat(32)}` as const, token: "0x54d6643762e46036b3448659791adaf554225541" as const, amount: 5n * 10n ** 18n, fee: 10n ** 16n };
const USER: Address = "0x5555555555555555555555555555555555555555";

describe("Asset Hub client: submitting a front", () => {
  it("simulates, submits and reports the block and extrinsic of the inclusion, then lets go of the subscription", async () => {
    const api = new FakeApi();
    api.submissions.push(included(`0x${"b1".repeat(32)}`, `0x${"c2".repeat(32)}`));
    const client = await newClient(api);

    const outcome = await client.front(request);

    expect(outcome).toEqual({ kind: "included", blockHash: `0x${"b1".repeat(32)}`, extrinsicHash: `0x${"c2".repeat(32)}` });
    expect(api.dryRuns.map((run) => run.functionName)).toEqual(["front"]);
    expect(api.unsubscribed).toBe(1);
    expect(api.listenerCount("disconnected")).toBe(0);
  });

  it("does not submit when the simulation reverts, and names the pool's error", async () => {
    const api = new FakeApi();
    api.frontDryRuns.push({ reverted: true, output: revertData("InsufficientFunds") });
    const client = await newClient(api);

    expect(await client.front(request)).toEqual({ kind: "reverted", reason: "InsufficientFunds", error: "InsufficientFunds" });
    expect(api.submitted).toBe(0);
  });

  it("reports a runtime error of the call itself as a revert, not a transport failure", async () => {
    const api = new FakeApi();
    api.frontDryRuns.push({ err: { module: "Revive" } });
    const client = await newClient(api);

    expect(await client.front(request)).toMatchObject({ kind: "reverted", reason: expect.stringContaining("call failed") });
    expect(api.submitted).toBe(0);
  });

  it("signs again when the transaction was rejected before inclusion, and gives up after three submissions", async () => {
    const api = new FakeApi();
    api.submissions.push(rejected("Invalid"), included());
    const client = await newClient(api);
    expect((await client.front(request)).kind).toBe("included");
    expect(api.submitted).toBe(2);

    const stubborn = new FakeApi();
    stubborn.submissions.push(rejected(), rejected(), rejected(), included());
    const other = await newClient(stubborn);
    await expect(other.front(request)).rejects.toThrow("extrinsic rejected: Invalid");
    expect(stubborn.submitted).toBe(3);
  });

  it("names the pool's error when the call reverts between simulation and inclusion", async () => {
    const api = new FakeApi();
    api.frontDryRuns.push({}, { reverted: true, output: revertData("AlreadyFronted") });
    api.submissions.push(dispatchFailed("ContractReverted"));
    const client = await newClient(api);

    expect(await client.front(request)).toEqual({ kind: "reverted", reason: "AlreadyFronted", error: "AlreadyFronted" });
    expect(api.dryRuns.map((run) => run.functionName)).toEqual(["front", "front"]);
  });

  it("throws any other dispatch failure, which the service retries after reading the chain again", async () => {
    const api = new FakeApi();
    api.submissions.push(dispatchFailed("StorageDepositLimitExhausted"));
    const client = await newClient(api);

    await expect(client.front(request)).rejects.toThrow("dispatch failed: revive.StorageDepositLimitExhausted");
  });

  it("stops waiting after the timeout with a transport error, without signing again", async () => {
    const api = new FakeApi();
    api.submissions.push(silent, included());
    const client = await newClient(api, { submitTimeoutMs: 40 });

    const error = await client.front(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toContain("timed out after 40 ms");
    expect(api.submitted).toBe(1);
    expect(api.unsubscribed).toBe(1);
    expect(api.listenerCount("disconnected")).toBe(0);
  });

  it("fails at once when the socket drops, because polkadot-js does not re-create the subscription", async () => {
    const api = new FakeApi();
    api.submissions.push(silent);
    const client = await newClient(api, { submitTimeoutMs: 60_000 });

    const pending = client.front(request).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    api.emit("disconnected");

    expect(await pending).toBeInstanceOf(TransportError);
    expect(((await pending) as Error).message).toContain("connection dropped");
  });

  it("fails at once when the caller aborts, so a shutdown does not wait for the timeout", async () => {
    const api = new FakeApi();
    api.submissions.push(silent);
    const client = await newClient(api, { submitTimeoutMs: 60_000 });
    const abort = new AbortController();

    const pending = client.front(request, abort.signal).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();

    expect(await pending).toBeInstanceOf(TransportError);
    expect(api.listenerCount("disconnected")).toBe(0);
  });

  it("does not submit at all for a signal that is already aborted", async () => {
    const api = new FakeApi();
    api.submissions.push(included());
    const client = await newClient(api);
    const abort = new AbortController();
    abort.abort();

    await expect(client.front(request, abort.signal)).rejects.toBeInstanceOf(TransportError);
    expect(api.submitted).toBe(0);
  });
});

describe("Asset Hub client: reading the pool", () => {
  it("reads the state of exactly one deposit, the payer's funds and the pool parameters from simulated calls", async () => {
    const api = new FakeApi();
    api.state = { status: DepositStatus.Fronted, payer: USER };
    const client = await newClient(api);

    expect(await client.deposit(request)).toEqual({ status: DepositStatus.Fronted, payer: USER });
    expect(api.dryRuns[0]).toEqual({ functionName: "state", args: [request.depositId, request.account, getAddress(request.token), request.amount] });
    expect(await client.funds(request.token)).toBe(10n ** 24n);
    expect(await client.poolParams()).toEqual({ bridgeFee: 10n ** 15n, capBps: 100 });
  });

  it("reports the finalized head as the block number", async () => {
    const api = new FakeApi();
    api.finalized = 4_321;

    expect(await (await newClient(api)).blockNumber()).toBe(4_321);
  });
});

describe("Asset Hub client: settlement events", () => {
  const topic = (signature: string) => toEventSelector(signature);

  it("takes only Settled events the pool emitted, and ignores other contracts, other topics and other pallets", async () => {
    const api = new FakeApi();
    const wanted = settledLog(11n, true, USER, 900n);
    const fronted = { topics: [topic("Fronted(uint256,address,bytes32,address,uint256,uint256)")], data: "0x" as const };
    api.events.set(5, [
      contractEmitted(NOT_POOL, wanted.topics, wanted.data),
      contractEmitted(POOL, fronted.topics, fronted.data),
      { section: "balances", method: "Transfer", values: [] },
      { section: "revive", method: "Instantiated", values: [] },
      contractEmitted(POOL, wanted.topics, wanted.data),
    ]);
    const other = settledLog(12n, false, "0x0000000000000000000000000000000000000000", 40n);
    api.events.set(6, [contractEmitted(POOL, other.topics, other.data)]);
    const client = await newClient(api);

    const { events, prunedBlocks } = await client.settledEvents(4, 7);

    expect(prunedBlocks).toEqual([]);
    expect(events).toEqual([
      { depositId: 11n, repaid: true, to: USER, amount: 900n, blockNumber: 5, blockHash: `0x${(5).toString(16).padStart(64, "0")}` },
      { depositId: 12n, repaid: false, to: "0x0000000000000000000000000000000000000000", amount: 40n, blockNumber: 6, blockHash: `0x${(6).toString(16).padStart(64, "0")}` },
    ]);
  });

  it("matches the pool by address whatever the case of the reported contract", async () => {
    const api = new FakeApi();
    const wanted = settledLog(3n, true, USER, 1n);
    api.events.set(1, [contractEmitted(POOL.toLowerCase() as Address, wanted.topics, wanted.data)]);

    const { events } = await (await newClient(api)).settledEvents(1, 1);

    expect(events.map((event) => event.depositId)).toEqual([3n]);
  });

  it("reports a block whose state was pruned and keeps reading the others", async () => {
    const api = new FakeApi();
    const wanted = settledLog(21n, true, USER, 5n);
    api.events.set(1, new Error("4003: Client error: Api called for an unknown Block: State already discarded for 0x01"));
    api.events.set(2, [contractEmitted(POOL, wanted.topics, wanted.data)]);
    api.events.set(3, new Error("State already discarded for 0x03"));
    const client = await newClient(api);

    const { events, prunedBlocks } = await client.settledEvents(1, 3);

    expect(prunedBlocks).toEqual([1, 3]);
    expect(events.map((event) => event.depositId)).toEqual([21n]);
  });

  it("throws any other read failure instead of skipping the block", async () => {
    const api = new FakeApi();
    api.events.set(2, new Error("WebSocket is not connected"));

    await expect((await newClient(api)).settledEvents(1, 3)).rejects.toThrow("WebSocket is not connected");
  });
});

describe("Asset Hub client: the payer", () => {
  it("derives the payer's H160 as pallet-revive does for a sr25519 account", async () => {
    const alice = await newClient(new FakeApi(), {}, "//Alice");
    const bob = await newClient(new FakeApi(), {}, "//Bob");

    expect(alice.payer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(alice.payer).not.toBe(bob.payer);
  });

  it("disconnects the API when closed", async () => {
    const api = new FakeApi();

    await (await newClient(api)).close();

    expect(api.disconnected).toBe(true);
  });
});
