import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ApiPromise } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { concat, size, toFunctionSelector, type Address, type Hex } from "viem";
import { connect } from "../../src/chain.js";
import { DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT, ETHEREUM_CHAIN_ID } from "../../src/constants.js";
import { deliveredProgram } from "../../src/delivered.js";
import { ethereumAccountLocation, ethereumSenderAccount, fallbackAccount, reviveAddress } from "../../src/location.js";
import { signedOriginNetwork } from "../../src/network.js";
import { assembleClaimer, assembleXcm, buildTemplate, type Template } from "../../src/template.js";
import { encodeVersionedXcm, reviveCall, routerProgram, settleAbi, settleCalldata, SETTLE_CALLDATA_LENGTH } from "../../src/xcm.js";

const POOL: Address = "0x5801b439a678d9d3a68b8019da6a4abfa507de11";
const FEE_ACCOUNT: Hex = `0x${"fe".repeat(32)}`;
const ROUTER: Address = "0x7e57000000000000000000000000000000000001";
const TOKEN: Address = "0x54d6643762e46036b3448659791adaf554225541";

const DEPOSITS = [
  { depositId: 1n, account: `0x${"11".repeat(32)}` as Hex, token: TOKEN, amount: 1n },
  { depositId: 2n ** 64n, account: `0x${"ab".repeat(32)}` as Hex, token: TOKEN, amount: 2n ** 128n - 1n },
  { depositId: 2n ** 256n - 1n, account: `0x${"00".repeat(32)}` as Hex, token: "0x0000000000000000000000000000000000000001" as Address, amount: 2n ** 256n - 1n },
];

describe("router template", () => {
  let api: ApiPromise;
  let template: Template;

  before(async () => {
    api = await connect();
    template = await buildTemplate(api, {
      pool: POOL,
      feeAccount: FEE_ACCOUNT,
      weightLimit: DEFAULT_SETTLE_WEIGHT,
      storageDepositLimit: DEFAULT_STORAGE_DEPOSIT_LIMIT,
    });
  });
  after(() => api.disconnect());

  it("spliced bytes equal the program encoded with the real calldata", () => {
    for (const deposit of DEPOSITS) {
      const call = reviveCall(api, POOL, settleCalldata(deposit), DEFAULT_SETTLE_WEIGHT, DEFAULT_STORAGE_DEPOSIT_LIMIT);
      const direct = encodeVersionedXcm(api, routerProgram(fallbackAccount(POOL), FEE_ACCOUNT, call));
      assert.equal(assembleXcm(template, deposit), direct);
    }
  });

  it("puts the length prefix of the 132 byte calldata right before the selector", () => {
    const selector = toFunctionSelector(settleAbi[0]);
    assert.equal(SETTLE_CALLDATA_LENGTH, 132);
    assert.ok(template.xcmHead.endsWith(`1102${selector.slice(2)}`));
  });

  it("encodes the call length so that the splice does not change it", () => {
    const [short, long] = [DEPOSITS[0]!, DEPOSITS[2]!].map((deposit) => assembleXcm(template, deposit));
    assert.equal(size(short as Hex), size(long as Hex));
  });

  it("builds a claimer that names the network a signed claim carries on the chain", async () => {
    const account: Hex = `0x${"22".repeat(32)}`;
    const network = await signedOriginNetwork(api);
    assert.deepEqual(network, { ByGenesis: "0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e" });
    const claimer = api.createType("StagingXcmV5Location", assembleClaimer(template, account)).toJSON();
    assert.deepEqual(claimer, {
      parents: 0,
      interior: { x1: [{ accountId32: { network: { byGenesis: network.ByGenesis }, id: account } }] },
    });
  });

  it("guards the settle with ExpectTransactStatus right after the Transact", () => {
    assert.ok(template.xcmTail.startsWith("0x200014"));
  });
  it("is accepted by the converter mirror and ends up between Bridge Hub's prefix and a topic", () => {
    const deposit = DEPOSITS[0]!;
    const program = deliveredProgram(api, {
      router: ROUTER,
      nonce: 7n,
      xcm: assembleXcm(template, deposit),
      claimer: assembleClaimer(template, deposit.account),
      value: 0n,
      executionFee: 1_000n,
      assets: [{ token: TOKEN, amount: deposit.amount }],
    });
    const names = (api.createType("StagingXcmV5Xcm", program).toJSON() as Record<string, unknown>[]).map((i) => Object.keys(i)[0]);
    assert.deepEqual(names, [
      "descendOrigin",
      "universalOrigin",
      "reserveAssetDeposited",
      "setHints",
      "payFees",
      "reserveAssetDeposited",
      "descendOrigin",
      "depositAsset",
      "transact",
      "expectTransactStatus",
      "refundSurplus",
      "depositAsset",
      "setTopic",
    ]);
  });

  it("rejects an xcm that Bridge Hub would silently replace with an empty program", () => {
    const deposit = DEPOSITS[0]!;
    const message = {
      router: ROUTER,
      nonce: 7n,
      claimer: assembleClaimer(template, deposit.account),
      value: 0n,
      executionFee: 1_000n,
      assets: [],
    };
    assert.throws(() => deliveredProgram(api, { ...message, xcm: concat([assembleXcm(template, deposit), "0x00"]) }));
    assert.throws(() => deliveredProgram(api, { ...message, xcm: assembleXcm(template, deposit).slice(0, -2) as Hex }));
  });
});

describe("account derivation", () => {
  let api: ApiPromise;
  before(async () => {
    api = await connect();
  });
  after(() => api.disconnect());

  it("matches the runtime's own location conversion and address mapping", async () => {
    for (const sender of [ROUTER, TOKEN, "0xffffffffffffffffffffffffffffffffffffffff" as Address]) {
      const location = ethereumAccountLocation(ETHEREUM_CHAIN_ID, sender);
      const onChain = (await api.call.locationToAccountApi.convertLocation({ V5: location })).toJSON() as { ok: string };
      const account = ethereumSenderAccount(ETHEREUM_CHAIN_ID, sender);
      assert.equal(u8aToHex(api.createType("AccountId32", onChain.ok).toU8a()), account);
      const address = (await api.call.reviveApi.address(account)).toHex();
      assert.equal(reviveAddress(account).toLowerCase(), address);
    }
  });

  it("maps a contract to its fallback account and back", async () => {
    const account = (await api.call.reviveApi.accountId(POOL)).toHex();
    assert.equal(account, fallbackAccount(POOL));
    assert.equal(reviveAddress(fallbackAccount(POOL)), "0x5801B439A678D9d3a68b8019dA6A4abFa507dE11");
  });
});
