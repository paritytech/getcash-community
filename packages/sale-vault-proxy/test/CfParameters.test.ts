import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import fc from "fast-check";
import { ARBITRUM_ONE } from "../config/networks";
import { BROKER_MAINNET, BROKER_TESTNET, encodeCfParameters, minPriceX128 } from "./helpers";

// Chainflip swap backend encodeCfParameters outputs for these inputs
const REFUND = "0x1234567890AbcdEF1234567890aBcdef12345678";
const MIN_PRICE = 336879543251729078828740861357450529341n;
const V_D_TESTNET =
  "0x01640000001234567890abcdef1234567890abcdef123456783d0ad7a3703d0ad7a3703d0ad7a370fd00000000000000000000000000000000000000009e8d88ae895c9b37b2dead9757a3452f7c2299704d91ddfa444d87723f94fe0c000000";
const V_D_MAINNET =
  "0x01640000001234567890abcdef1234567890abcdef123456783d0ad7a3703d0ad7a3703d0ad7a370fd000000000000000000000000000000000000000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000";
const DERIVED_PROXY = "0xfb63126B916e3bD2497702a0139AD2B344aC7536";
const DERIVED_MIN_PRICE = 326671072244100924924839623134497482997n;
const DERIVED =
  "0x0164000000fb63126b916e3bd2497702a0139ad2b344ac7536f5285c8fc2f5285c8fc2f5285c8fc2f5000000000000000000000000000000000000000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000";

async function harness() {
  return (await ethers.getContractFactory("CfParametersHarness")).deploy();
}

describe("CfParameters", () => {
  it("reproduces the testnet and mainnet backend vectors byte for byte", async () => {
    const h = await loadFixture(harness);
    expect(await h.encode(100, REFUND, MIN_PRICE, BROKER_TESTNET)).to.equal(V_D_TESTNET);
    expect(await h.encode(100, REFUND, MIN_PRICE, BROKER_MAINNET)).to.equal(V_D_MAINNET);
    expect(encodeCfParameters(100, REFUND, MIN_PRICE, BROKER_TESTNET)).to.equal(V_D_TESTNET);
  });

  it("matches the derived 20 USDC vector", async () => {
    const h = await loadFixture(harness);
    expect(await h.minPriceX128(20_000_000n, 9900n, 600_000n)).to.equal(DERIVED_MIN_PRICE);
    expect(await h.encode(100, DERIVED_PROXY, DERIVED_MIN_PRICE, BROKER_MAINNET)).to.equal(DERIVED);
  });

  it("is always 96 bytes with the option and boost bytes zero", async () => {
    const h = await loadFixture(harness);
    const out = await h.encode(600, REFUND, 2n ** 255n, BROKER_MAINNET);
    expect(ethers.dataLength(out)).to.equal(96);
    expect(ethers.dataSlice(out, 57, 61)).to.equal("0x00000000");
    expect(ethers.dataSlice(out, 93, 96)).to.equal("0x000000");
  });

  it("places retry little-endian, the refund raw and the broker at 61", async () => {
    const h = await loadFixture(harness);
    const cases: [number, string][] = [
      [1, "0x01000000"],
      [100, "0x64000000"],
      [600, "0x58020000"],
      [0x01020304, "0x04030201"],
    ];
    for (const [retry, bytes] of cases) {
      const out = await h.encode(retry, REFUND, 1n, BROKER_MAINNET);
      expect(ethers.dataSlice(out, 0, 1)).to.equal("0x01");
      expect(ethers.dataSlice(out, 1, 5)).to.equal(bytes);
      expect(ethers.dataSlice(out, 5, 25)).to.equal(REFUND.toLowerCase());
      expect(ethers.dataSlice(out, 25, 57)).to.equal("0x01" + "00".repeat(31));
      expect(ethers.dataSlice(out, 61, 93)).to.equal(BROKER_MAINNET);
    }
  });

  it("minPriceX128 of 10 USDC at 9900 with no allowance is the vector input", async () => {
    const h = await loadFixture(harness);
    expect(await h.minPriceX128(10_000_000n, 9900n, 0n)).to.equal(MIN_PRICE);
    expect(minPriceX128(10_000_000n, 9900n, 0n)).to.equal(MIN_PRICE);
  });

  it("minPriceX128 equals the TS mirror at or above the minimum return", async () => {
    const h = await loadFixture(harness);
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: ARBITRUM_ONE.minReturn, max: 10n ** 13n }),
        fc.bigInt({ min: 9500n, max: 10_000n }),
        async (amount, floor) => {
          const want = minPriceX128(amount, floor, ARBITRUM_ONE.feeAllowance);
          return (await h.minPriceX128(amount, floor, ARBITRUM_ONE.feeAllowance)) === want;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("reverts when the floor output is below the fee allowance", async () => {
    const h = await loadFixture(harness);
    await expect(h.minPriceX128(500_000n, 9900n, 600_000n)).to.be.revertedWithPanic(0x11);
  });
});
