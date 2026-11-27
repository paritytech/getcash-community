import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ApiPromise } from "@polkadot/api";
import type { Address } from "viem";
import { connect } from "../../src/chain.js";
import { foreignAssetPrecompile } from "../../src/location.js";
import { assertPrecompileIsFor, foreignAssetIndex } from "../../src/revive.js";

const TOKEN: Address = "0x54D6643762E46036b3448659791adAf554225541";

describe("the ERC-20 precompile the pool is deployed with", () => {
  let api: ApiPromise;
  before(async () => {
    api = await connect();
  });
  after(() => api.disconnect());

  it("accepts the precompile of the token's own asset index", async () => {
    await assertPrecompileIsFor(api, foreignAssetPrecompile(await foreignAssetIndex(api, TOKEN)), TOKEN);
  });

  it("refuses the precompile of another asset, an unmapped index and a foreign address", async () => {
    await assert.rejects(assertPrecompileIsFor(api, foreignAssetPrecompile(0), TOKEN), /is not the foreign asset of/);
    await assert.rejects(assertPrecompileIsFor(api, foreignAssetPrecompile(999), TOKEN), /is not the foreign asset of/);
    await assert.rejects(assertPrecompileIsFor(api, TOKEN, TOKEN), /not a foreign-assets ERC-20 precompile/);
  });
});
