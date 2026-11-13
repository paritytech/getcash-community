import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deploySystem } from "./helpers";

// The factory drives the treasury end to end in SaleVaultProxyFactory.test.ts. Here only the
// guards that the factory can never reach: a stranger calling quarantine or recover directly.
describe("QuarantineTreasury", () => {
  const reason = (s: string) => ethers.encodeBytes32String(s);

  it("wires the factory and USDC it was deployed with", async () => {
    const s = await loadFixture(deploySystem);
    expect(await s.quarantine.FACTORY()).to.equal(await s.factory.getAddress());
    expect(await s.quarantine.USDC()).to.equal(await s.usdc.getAddress());
    expect(await s.quarantine.total()).to.equal(0n);
  });

  it("lets only the factory book a delivery", async () => {
    const s = await loadFixture(deploySystem);
    await expect(
      s.quarantine
        .connect(s.stranger)
        .quarantine(0n, 100n, reason("message"), ethers.ZeroHash, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(s.quarantine, "NotFactory");
  });

  it("lets only the factory recover a delivery", async () => {
    const s = await loadFixture(deploySystem);
    await expect(
      s.quarantine.connect(s.stranger).recover(0n, s.recipient.address),
    ).to.be.revertedWithCustomError(s.quarantine, "NotFactory");
    // The deployer is the factory's recoverer, not the treasury's caller
    await expect(
      s.quarantine.connect(s.deployer).recover(0n, s.recipient.address),
    ).to.be.revertedWithCustomError(s.quarantine, "NotFactory");
  });
});
