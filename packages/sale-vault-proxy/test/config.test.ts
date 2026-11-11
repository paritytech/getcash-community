import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ARBITRUM_ONE,
  ARBITRUM_SEPOLIA,
  CF_BLOCK_SECONDS,
  CF_MAX_SWAP_REQUEST_BLOCKS,
  MAX_BACKOFF_SHIFT,
  PRICE_FLOOR_BPS,
  RELEASE_ATTEMPTS,
  RELEASE_DELAY,
  STALE_DELAY,
  adapterSaleVaultProxy,
  factoryConfig,
  networkVectors,
} from "../config/networks";
import vectors from "../vectors.json";
import { deployMocks, minPriceX128 } from "./helpers";

const DAY = 86_400n;

describe("release constants", () => {
  it("derive from Chainflip's swap request cap, the proxy backoff and the keeper watch", () => {
    expect(CF_BLOCK_SECONDS).to.equal(6n);
    expect(CF_MAX_SWAP_REQUEST_BLOCKS).to.equal(14_400n);
    expect(RELEASE_DELAY).to.equal(DAY);
    expect(RELEASE_ATTEMPTS).to.equal(MAX_BACKOFF_SHIFT + 1n);
    expect(STALE_DELAY).to.equal(60n * DAY);
  });

  for (const net of [ARBITRUM_ONE, ARBITRUM_SEPOLIA]) {
    it(`chain ${net.chainId}: a killed return refunds well inside RELEASE_DELAY and a refund loop never trips STALE_DELAY`, async () => {
      expect(BigInt(net.retryBlocks) * CF_BLOCK_SECONDS < net.releaseDelay).to.equal(true);
      expect(net.returnCooldown << MAX_BACKOFF_SHIFT < net.staleDelay).to.equal(true);
      expect(net.returnCooldown > BigInt(net.retryBlocks) * CF_BLOCK_SECONDS).to.equal(true);
      const [, treasury, , , guardian, pauser] = await ethers.getSigners();
      const { usdc, vault } = await deployMocks();
      const mocked = { ...net, vault: await vault.getAddress(), usdc: await usdc.getAddress() };
      const Factory = await ethers.getContractFactory("SaleVaultProxyFactory");
      await expect(
        Factory.deploy(factoryConfig(mocked, treasury.address, guardian.address, pauser.address)),
      ).to.not.be.reverted;
    });
  }

  for (const net of [ARBITRUM_ONE, ARBITRUM_SEPOLIA]) {
    it(`chain ${net.chainId}: a held minSale stays returnable through every killed return before release`, () => {
      expect(net.minSale >= net.minReturn + (net.releaseAttempts - 1n) * net.refundFee).to.equal(
        true,
      );
    });
  }
});

// The app and worker read minSale and the release clocks from vectors.json, so a config edit needs `pnpm vectors`
describe("vectors.json networks", () => {
  for (const net of [ARBITRUM_ONE, ARBITRUM_SEPOLIA]) {
    it(`chain ${net.chainId} matches config/networks.ts`, () => {
      const written = (vectors.networks as Record<string, unknown>)[String(net.chainId)];
      expect(written).to.deep.equal(networkVectors(net));
    });
  }
});

// The return's fill-or-kill floor: a stable USDC to USDT pair, with the egress and network fee
// taken off by a separate fixed allowance, so the floor only covers the pool fee and the spread.
describe("price floor", () => {
  it("is 9950 bps, a 0.5% floor, not the looser 1%", () => {
    expect(PRICE_FLOOR_BPS).to.equal(9950n);
    expect(ARBITRUM_ONE.priceFloorBps).to.equal(PRICE_FLOOR_BPS);
    expect(ARBITRUM_SEPOLIA.priceFloorBps).to.equal(PRICE_FLOOR_BPS);
  });

  // A floor edit without `pnpm vectors` leaves the app and adapter copying a stale minPriceX128
  it("vectors.json cfParameters match the configured floor and allowance", () => {
    const cf = vectors.cfParameters;
    expect(BigInt(cf.derived.floorBps)).to.equal(PRICE_FLOOR_BPS);
    expect(BigInt(cf.derived.feeAllowance)).to.equal(ARBITRUM_ONE.feeAllowance);
    expect(BigInt(cf.derived.minPriceX128)).to.equal(
      minPriceX128(BigInt(cf.derived.amount), PRICE_FLOOR_BPS, ARBITRUM_ONE.feeAllowance),
    );
    const vectorPrice = minPriceX128(10_000_000n, PRICE_FLOOR_BPS, 0n);
    expect(BigInt(cf.mainnet.minPriceX128)).to.equal(vectorPrice);
    expect(BigInt(cf.testnet.minPriceX128)).to.equal(vectorPrice);
  });

  // The least USDT a 10k return accepts, pinned to an independent figure so a change to the floor
  // or the allowance is caught: 10000 * 0.995 - 0.6 = 9949.4 USDT, an effective floor of 99.494%.
  it("a 10k USDC return accepts no less than 9949.4 USDT", () => {
    const amount = 10_000_000_000n;
    const minOut = (amount * PRICE_FLOOR_BPS) / 10_000n - ARBITRUM_ONE.feeAllowance;
    expect(minOut).to.equal(9_949_400_000n);
  });
});

// Mirrors the adapter's strict sale_vault_proxy schema, deploy prints only these keys
describe("deploy's adapter block", () => {
  const BLOCK_KEYS = [
    "chain_id",
    "factory",
    "retired",
    "chainflip_vault",
    "usdc",
    "rpc_url",
    "keeper_key",
    "keeper",
    "chainflip",
  ];
  const CHAINFLIP_KEYS = ["rpc_url", "backend_url", "quote_margin_bps", "limits_ttl_ms"];

  for (const net of [ARBITRUM_ONE, ARBITRUM_SEPOLIA]) {
    it(`chain ${net.chainId}: every key is one the adapter accepts outside development`, () => {
      const block = adapterSaleVaultProxy(net, ethers.ZeroAddress);
      expect(BLOCK_KEYS).to.include.members(Object.keys(block));
      expect(CHAINFLIP_KEYS).to.include.members(Object.keys(block.chainflip));
      expect(block.chainflip).to.not.have.property("backend_url");
      expect(block.chain_id).to.equal(net.chainId);
    });
  }
});

// packages/chainflip is ESM and this package is CJS, so its constants are read as text
describe("mirrors packages/chainflip", () => {
  const src = (file: string) => readFileSync(join(__dirname, "../../chainflip/src", file), "utf8");

  it("the State Chain RPCs, swap backends and chain ids match", () => {
    expect(src("channel-expiry.ts")).to.include(`"${ARBITRUM_ONE.chainflipRpc}"`);
    expect(src("channel-expiry.ts")).to.include(`"${ARBITRUM_SEPOLIA.chainflipRpc}"`);
    expect(src("swap-status.ts")).to.include(`"${ARBITRUM_ONE.swapApi}"`);
    expect(src("swap-status.ts")).to.include(`"${ARBITRUM_SEPOLIA.swapApi}"`);
    expect(src("sale-vault-proxy.ts")).to.include(`mainnet: ${ARBITRUM_ONE.chainId},`);
    expect(src("sale-vault-proxy.ts")).to.include(`perseverance: ${ARBITRUM_SEPOLIA.chainId},`);
  });
});
