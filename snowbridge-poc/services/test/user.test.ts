import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, keccak256, toBytes, isAddress, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { factoryAbi, forwarderAbi } from "../src/common/abi";
import { loadForwarderCreationCode } from "../src/common/artifacts";
import {
  connect,
  deriveUser,
  getDeposits,
  predictDepositAddress,
  readWithdrawNonce,
  signWithdraw,
  submitWithdraw,
  withdrawTypedData,
} from "../src/user";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { newDepositor } from "./helpers/depositor";
import { startHarness, type Harness } from "./helpers/harness";
import { deployStack, mintTo, tokenBalance, type Stack } from "./helpers/stack";

const run = promisify(execFile);
const servicesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const creationCode = loadForwarderCreationCode();

let anvil: Anvil;
let stack: Stack;
const open: Harness[] = [];

beforeAll(async () => {
  anvil = await startAnvil();
  stack = await deployStack(anvil.url);
});

afterAll(async () => {
  await anvil.stop();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function deployForwarder(account: Hex, owner: Address): Promise<Address> {
  const hash = await stack.clientFor(stack.admin).writeContract({
    address: stack.factory,
    abi: factoryAbi,
    functionName: "deploy",
    args: [account, owner],
  });
  const receipt = await stack.publicClient.waitForTransactionReceipt({ hash });
  const [deployed] = parseEventLogs({ abi: factoryAbi, eventName: "ForwarderDeployed", logs: receipt.logs });
  return deployed!.args.forwarder;
}

describe("user derivation", () => {
  it("is deterministic and differs per seed", () => {
    const first = deriveUser("seed one");
    const again = deriveUser("seed one");
    const other = deriveUser("seed two");

    expect(again.owner.address).toBe(first.owner.address);
    expect(again.assetHubAccount).toBe(first.assetHubAccount);
    expect(other.owner.address).not.toBe(first.owner.address);
    expect(other.assetHubAccount).not.toBe(first.assetHubAccount);
    expect(first.assetHubAccount).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.assetHubAddress.length).toBeGreaterThan(40);

    const ownerKey = keccak256(toBytes("getcash-poc/owner/seed one"));
    expect(privateKeyToAccount(ownerKey).address).toBe(first.owner.address);
    expect(JSON.stringify(first)).not.toContain(ownerKey.slice(2));
  });
});

describe("deposit address", () => {
  it("equals ForwarderFactory.predict", async () => {
    const pairs = ["a", "b", "c", "d"].map((seed) => deriveUser(seed));
    pairs.push({ ...pairs[0]!, assetHubAccount: pairs[1]!.assetHubAccount });

    for (const user of pairs) {
      const local = predictDepositAddress({
        factory: stack.factory,
        account: user.assetHubAccount,
        owner: user.owner.address,
        creationCode,
      });
      const onChain = await stack.publicClient.readContract({
        address: stack.factory,
        abi: factoryAbi,
        functionName: "predict",
        args: [user.assetHubAccount, user.owner.address],
      });
      expect(local).toBe(onChain);
    }
  });

  it("is where the factory deploys the forwarder, and depends on the factory", async () => {
    const user = deriveUser("deployed");
    const local = predictDepositAddress({ factory: stack.factory, account: user.assetHubAccount, owner: user.owner.address, creationCode });

    expect(await deployForwarder(user.assetHubAccount, user.owner.address)).toBe(local);
    expect(predictDepositAddress({ factory: stack.router, account: user.assetHubAccount, owner: user.owner.address, creationCode })).not.toBe(
      local,
    );
  });
});

describe("owner withdraw", () => {
  async function fundedForwarder(seed: string, amount: bigint) {
    const user = deriveUser(seed);
    const forwarder = await deployForwarder(user.assetHubAccount, user.owner.address);
    await mintTo(stack, stack.token, forwarder, amount);
    return { user, forwarder };
  }

  it("signs the EIP-712 digest the forwarder computes", async () => {
    const { user, forwarder } = await fundedForwarder("digest", 1n);
    const request = { chainId: stack.chain.id, forwarder, token: stack.token, to: user.owner.address, amount: 1n, nonce: 0n, deadline: 2n ** 40n };

    const onChain = await stack.publicClient.readContract({
      address: forwarder,
      abi: forwarderAbi,
      functionName: "withdrawDigest",
      args: [request.token, request.to, request.amount, request.nonce, request.deadline],
    });

    expect(hashTypedData(withdrawTypedData(request))).toBe(onChain);
  });

  it("is accepted from any submitter, once", async () => {
    const { user, forwarder } = await fundedForwarder("withdrawer", 8_000_000n);
    const recipient = (await stack.newWallet("0")).account.address;
    const stranger = await connect(stack.rpcUrl, (await stack.newWallet()).account);
    const request = {
      chainId: stack.chain.id,
      forwarder,
      token: stack.token,
      to: recipient,
      amount: 3_000_000n,
      nonce: await readWithdrawNonce(stranger, forwarder),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };
    const signature = await signWithdraw(user.owner, request);

    await submitWithdraw(stranger, forwarder, { ...request, signature });

    expect(await tokenBalance(stack, stack.token, recipient)).toBe(3_000_000n);
    expect(await tokenBalance(stack, stack.token, forwarder)).toBe(5_000_000n);
    expect(await readWithdrawNonce(stranger, forwarder)).toBe(1n);
    await expect(submitWithdraw(stranger, forwarder, { ...request, signature })).rejects.toThrow();
  });

  it("is rejected when signed for another forwarder, by another key, or past its deadline", async () => {
    const { user, forwarder } = await fundedForwarder("rejected", 2_000_000n);
    const other = await fundedForwarder("rejected-other", 2_000_000n);
    const stranger = await connect(stack.rpcUrl, (await stack.newWallet()).account);
    const base = {
      chainId: stack.chain.id,
      forwarder,
      token: stack.token,
      to: user.owner.address,
      amount: 1_000_000n,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };
    const submit = (signature: Hex, deadline = base.deadline) =>
      submitWithdraw(stranger, forwarder, { token: base.token, to: base.to, amount: base.amount, deadline, signature });

    await expect(submit(await signWithdraw(user.owner, { ...base, forwarder: other.forwarder }))).rejects.toThrow();
    await expect(submit(await signWithdraw(other.user.owner, base))).rejects.toThrow();
    await expect(submit(await signWithdraw(user.owner, { ...base, chainId: base.chainId + 1 }))).rejects.toThrow();
    const expired = 1n;
    await expect(submit(await signWithdraw(user.owner, { ...base, deadline: expired }), expired)).rejects.toThrow();

    expect(await tokenBalance(stack, stack.token, forwarder)).toBe(2_000_000n);
    await submit(await signWithdraw(user.owner, base));
    expect(await tokenBalance(stack, stack.token, forwarder)).toBe(1_000_000n);
  });

  it("can withdraw ether with the zero address as token", async () => {
    const user = deriveUser("ether");
    const forwarder = await deployForwarder(user.assetHubAccount, user.owner.address);
    await stack.testClient.setBalance({ address: forwarder, value: 10n ** 18n });
    const recipient = (await stack.newWallet("0")).account.address;
    const stranger = await connect(stack.rpcUrl, (await stack.newWallet()).account);
    const request = {
      chainId: stack.chain.id,
      forwarder,
      token: zeroAddress,
      to: recipient,
      amount: 4n * 10n ** 17n,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };

    await submitWithdraw(stranger, forwarder, { ...request, signature: await signWithdraw(user.owner, request) });

    expect(await stack.publicClient.getBalance({ address: recipient })).toBe(4n * 10n ** 17n);
  });
});

describe("user cli", () => {
  const cli = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "src/user/cli.ts", ...args], { cwd: servicesDir }).then((result) => result.stdout);

  it("registers, sends and reports through the trigger service", async () => {
    const harness = await startHarness(stack);
    open.push(harness);
    const common = ["--seed", "cli user", "--factory", stack.factory];
    const alice = newDepositor(stack, "cli user");

    const printed = JSON.parse(await cli("address", ...common)) as { owner: Address; depositAddress: Address; assetHubAddress: string };
    expect(printed.depositAddress).toBe(alice.deposit);
    expect(printed.owner).toBe(alice.user.owner.address);
    expect(isAddress(printed.owner)).toBe(true);

    expect(JSON.parse(await cli("register", ...common, "--trigger-url", harness.baseUrl))).toEqual({ depositAddress: alice.deposit, created: true });

    await mintTo(stack, stack.token, alice.user.owner.address, 6_000_000n);
    await stack.testClient.setBalance({ address: alice.user.owner.address, value: 10n ** 18n });
    await cli("send", ...common, "--rpc", stack.rpcUrl, "--token", stack.token, "--amount", "6000000");
    expect(await tokenBalance(stack, stack.token, alice.deposit)).toBe(6_000_000n);

    await harness.service.tick();
    const status = JSON.parse(await cli("status", ...common, "--trigger-url", harness.baseUrl)) as Awaited<ReturnType<typeof getDeposits>>;
    expect(status.deposits).toHaveLength(1);
    expect(status.deposits[0]?.amount).toBe("6000000");
  });

  it("signs a withdraw and submits it", async () => {
    const user = deriveUser("cli withdraw");
    const forwarder = await deployForwarder(user.assetHubAccount, user.owner.address);
    await mintTo(stack, stack.token, forwarder, 2_000_000n);
    await stack.testClient.setBalance({ address: user.owner.address, value: 10n ** 18n });
    const recipient = (await stack.newWallet("0")).account.address;

    const printed = JSON.parse(
      await cli("withdraw", "--seed", "cli withdraw", "--factory", stack.factory, "--rpc", stack.rpcUrl, "--token", stack.token, "--to", recipient, "--amount", "500000"),
    ) as { forwarder: Address; signature: Hex };
    expect(printed.forwarder).toBe(forwarder);
    expect(printed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await tokenBalance(stack, stack.token, recipient)).toBe(0n);

    await cli("withdraw", "--seed", "cli withdraw", "--factory", stack.factory, "--rpc", stack.rpcUrl, "--token", stack.token, "--to", recipient, "--amount", "500000", "--submit");
    expect(await tokenBalance(stack, stack.token, recipient)).toBe(500_000n);
  });
});
