// The permit on a local fork of Hydration. A new Ethereum key gets HOLLAR on its Hydration
// account, as the mint of a deposit would give it. The key signs one permit, and the bytes of the
// permit go to the fork as they are, with no account that pays for them. The call swaps the
// HOLLAR for USDT and sends it on. The message it sends then goes into a block of a fork of Asset
// Hub, and the balance of the request's account is read there.
//   npx @acala-network/chopsticks@1.5.2 --endpoint wss://rpc.hydradx.cloud --port 8012
//   npx @acala-network/chopsticks@1.5.2 --endpoint wss://polkadot-asset-hub-rpc.polkadot.io --port 8013
//   VERIFY_BRIDGE_HYDRATION_FORK=ws://127.0.0.1:8012 VERIFY_BRIDGE_ASSET_HUB_FORK=ws://127.0.0.1:8013 \
//   pnpm vitest run tests/verify-bridge-base-permit.test.ts

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { AccountId } from "polkadot-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evmAddressOf,
  hollarProgram,
  hydrationAccountOf,
  permitExtrinsic,
  signPermit,
  type HydrationPermit,
} from "@getsome/bridge";
import { deriveKeypair } from "@getsome/ephemeral";
import { connectFork, pageTo, ranFrom, readBlock, receive, soon, type Fork } from "./bridge-forks";

const HYDRATION = process.env.VERIFY_BRIDGE_HYDRATION_FORK;
const ASSET_HUB = process.env.VERIFY_BRIDGE_ASSET_HUB_FORK;
const ON = [HYDRATION, ASSET_HUB].every((url) => url !== undefined && url !== "");

const HOLLAR_ID = 222;
const USDT_ID = 10;
const ONE_HOLLAR = 10n ** 18n;
/** The HOLLAR the key keeps for the fee of its permit. */
const FEE_RESERVE = ONE_HOLLAR / 10n;
const DISPATCH = "0x0000000000000000000000000000000000000401";
const best = { at: "best" };

/** A number as the fork's own client takes a 256 bit value: four parts, the lowest first. */
const parts = (value: bigint): bigint[] => {
  const mask = (1n << 64n) - 1n;
  return [value & mask, (value >> 64n) & mask, (value >> 128n) & mask, (value >> 192n) & mask];
};

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.runIf(ON)("the permit on a local fork of Hydration", () => {
  let hydration: Fork;
  let assetHub: Fork;

  beforeAll(async () => {
    hydration = connectFork(HYDRATION!);
    assetHub = connectFork(ASSET_HUB!);
    // A helper with HDX and USDT buys HOLLAR, to give it to the keys of the tests.
    const helper = deriveKeypair(new Uint8Array(32).fill(7));
    await hydration.client._request("dev_setStorage", [
      {
        System: {
          Account: [[[helper.address], { providers: 1, data: { free: "100000000000000" } }]],
        },
        Tokens: { Accounts: [[[helper.address, USDT_ID], { free: "500000000" }]] },
      },
    ]);
    const bought = await hydration.api.tx.Router.sell({
      asset_in: USDT_ID,
      asset_out: HOLLAR_ID,
      amount_in: 200_000_000n,
      min_amount_out: 0n,
      route: [],
    }).signAndSubmit(helper.signer);
    expect(bought.ok).toBe(true);
  }, 600_000);
  afterAll(() => [hydration, assetHub].forEach((fork) => fork?.client.destroy()));

  /** A new Ethereum key with `hollar` on its Hydration account, as a mint would leave it. */
  async function keyWith(hollar: bigint) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const address = evmAddressOf(key);
    const account = AccountId(0).dec(hexToBytes(hydrationAccountOf(address).slice(2)));
    const helper = deriveKeypair(new Uint8Array(32).fill(7));
    const given = await hydration.api.tx.Currencies.transfer({
      dest: account,
      currency_id: HOLLAR_ID,
      amount: hollar,
    }).signAndSubmit(helper.signer);
    expect(given.ok).toBe(true);
    return { key, address, account };
  }

  const hollarOf = (account: string): Promise<bigint> =>
    hydration.api.apis.CurrenciesApi.free_balance(HOLLAR_ID, account, best);
  const usdtOf = async (account: string): Promise<bigint> =>
    (await hydration.api.query.Tokens.Accounts.getValue(account, USDT_ID, best)).free;

  /** The call of the permit: the key's account pays its fees in HOLLAR and runs the program.
   *  The fork's own metadata encodes it, because the repo has no metadata of Hydration. */
  async function callFor(request: string, hollar: bigint): Promise<Uint8Array> {
    const api = hydration.api;
    const message = {
      type: "V5",
      value: hollarProgram({
        account: request,
        hollar,
        minimumUsdt: (hollar / 10n ** 12n / 100n) * 99n,
        assetHubFeeUsdt: 75_700n,
      }),
    };
    const weight = await api.apis.XcmPaymentApi.query_xcm_weight(message, best);
    const batch = api.tx.Utility.batch_all({
      calls: [
        api.tx.MultiTransactionPayment.set_currency({ currency: HOLLAR_ID }).decodedCall,
        api.tx.PolkadotXcm.execute({ message, max_weight: weight.value }).decodedCall,
      ],
    });
    const encoded: any = await batch.getEncodedData();
    return typeof encoded === "string" ? hexToBytes(encoded.replace(/^0x/, "")) : encoded;
  }

  const permitFor = async (address: string, call: Uint8Array, gasLimit: bigint) => {
    const now: bigint = await hydration.api.query.Timestamp.Now.getValue(best);
    const permit: HydrationPermit = {
      from: address,
      call,
      gasLimit,
      nonce: 0n,
      deadline: now / 1000n + 3600n,
    };
    return permit;
  };

  it("swaps all the HOLLAR of the key and sends all the USDT, with one permit", async () => {
    const { key, address, account } = await keyWith(50n * ONE_HOLLAR);
    const request = deriveKeypair(crypto.getRandomValues(new Uint8Array(32)));
    const hollar = 50n * ONE_HOLLAR - FEE_RESERVE;
    const call = await callFor(`0x${bytesToHex(request.publicKey)}`, hollar);
    const permit = await permitFor(address, call, 5_000_000n);
    const signature = signPermit(permit, key);
    const extrinsic = permitExtrinsic(permit, signature);

    // The bytes are the ones the fork's own metadata gives for the same permit.
    const own: any = await hydration.api.tx.MultiTransactionPayment.dispatch_permit({
      from: address,
      to: DISPATCH,
      value: parts(0n),
      data: call,
      gas_limit: permit.gasLimit,
      deadline: parts(permit.deadline),
      v: signature.v,
      r: `0x${bytesToHex(signature.r)}`,
      s: `0x${bytesToHex(signature.s)}`,
    }).getBareTx();
    expect(`0x${bytesToHex(extrinsic)}`).toBe(
      typeof own === "string" ? own : `0x${bytesToHex(own)}`,
    );

    const head = () => hydration.client._request<string, []>("chain_getBlockHash", []);
    const before = await head();
    await hydration.client._request("author_submitExtrinsic", [`0x${bytesToHex(extrinsic)}`]);
    const hash = await soon(async () => {
      const now = await head();
      if (now === before) throw new Error("the fork made no block");
      return now;
    });
    const block = await readBlock(hydration, hash);
    const named = (pallet: string, name: string) =>
      block.events.filter((e) => e.pallet === pallet && e.name === name);
    expect(named("System", "ExtrinsicFailed")).toHaveLength(0);
    expect(named("Utility", "BatchCompleted")).toHaveLength(1);
    const swap = named("Router", "Executed")[0]!.fields;
    expect(swap).toMatchObject({ asset_in: HOLLAR_ID, asset_out: USDT_ID, amount_in: hollar });

    // The key keeps no USDT, and of its HOLLAR only what the fee did not use.
    const left = await hollarOf(account);
    expect(await usdtOf(account)).toBe(0n);
    expect(left).toBeGreaterThan(0n);
    expect(left).toBeLessThan(FEE_RESERVE);

    const page = pageTo(block, 1000);
    expect(page).not.toBeNull();
    const arrival = await receive(assetHub, 2034, page!);
    expect(ranFrom(arrival, 2034)).toBe(true);
    const landed = await soon<any>(() =>
      assetHub.api.query.Assets.Account.getValue(1984, request.address, { at: arrival.hash }),
    );
    console.log(
      `${hollar} HOLLAR units gave ${swap.amount_out} USDT; the request's account holds ${landed?.balance}; the key keeps ${left} HOLLAR units`,
    );
    expect(landed.balance).toBeGreaterThan((swap.amount_out * 999n) / 1000n);
    expect(landed.balance).toBeLessThanOrEqual(swap.amount_out);
  }, 600_000);

  it("is refused when its gas does not cover the call, and the key keeps its HOLLAR", async () => {
    const { key, address, account } = await keyWith(50n * ONE_HOLLAR);
    const request = deriveKeypair(crypto.getRandomValues(new Uint8Array(32)));
    const call = await callFor(
      `0x${bytesToHex(request.publicKey)}`,
      50n * ONE_HOLLAR - FEE_RESERVE,
    );
    const permit = await permitFor(address, call, 1_000_000n);
    const extrinsic = permitExtrinsic(permit, signPermit(permit, key));
    await expect(
      hydration.client._request("author_submitExtrinsic", [`0x${bytesToHex(extrinsic)}`]),
    ).rejects.toThrow();
    expect(await hollarOf(account)).toBe(50n * ONE_HOLLAR);
  }, 600_000);
});
