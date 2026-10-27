import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import fc from "fast-check";
import { CLAIMER, cloneArgs, deploySystem, initcodeHash, predictProxy, proxySalt } from "./helpers";

const F = "0x1111111111111111111111111111111111111111";
const I = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const HOME_AB = "0x" + "ab".repeat(32);
const HOME_ALICE = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

describe("proxy address", () => {
  it("matches the pinned offline vectors", () => {
    expect(cloneArgs(HOME_AB, C)).to.equal(HOME_AB + C.slice(2));
    expect(proxySalt(HOME_AB, C)).to.equal(
      "0x966ba05a9ce5a2a399566f929d36e3fe95425c488fb5b676e831f497b63d4adc",
    );
    expect(initcodeHash(I, HOME_AB, C)).to.equal(
      "0x73c979d0db47d948377325ee5404793da3b3ca4a542ca0777eb59ac225b3eecf",
    );
    expect(predictProxy(F, I, HOME_AB, C)).to.equal("0xcc7d876cC298b0e30157D6c2656FBC6Fc66deeC7");
    expect(proxySalt(HOME_ALICE, C)).to.equal(
      "0x756d7b3730cbbbaaeb2127b77653ed4bcde1479c25672a19bc59b7c34f92e847",
    );
    expect(initcodeHash(I, HOME_ALICE, C)).to.equal(
      "0x927aa0ff6d2511517ac84f4f46365a722985e4335de1770c8b295c99874c4be9",
    );
    expect(predictProxy(F, I, HOME_ALICE, C)).to.equal(
      "0xB7967f92Fd611b5fF68b6A043DAf49034Cad476B",
    );
  });

  it("factory.predict equals the TS formula for random homes and claimers", async () => {
    const s = await loadFixture(deploySystem);
    const factory = await s.factory.getAddress();
    const impl = await s.factory.IMPLEMENTATION();
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        async (h, c) => {
          const home = ethers.hexlify(h);
          const claimer = ethers.getAddress(ethers.hexlify(c));
          fc.pre(claimer !== ethers.ZeroAddress);
          return (
            (await s.factory.predict(home, claimer)) === predictProxy(factory, impl, home, claimer)
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  it("deploy lands at the predicted address with home then claimer as its args", async () => {
    const s = await loadFixture(deploySystem);
    const factory = await s.factory.getAddress();
    const impl = await s.factory.IMPLEMENTATION();
    const want = predictProxy(factory, impl, HOME_ALICE, CLAIMER);
    await expect(s.factory.deploy(HOME_ALICE, CLAIMER))
      .to.emit(s.factory, "ProxyDeployed")
      .withArgs(HOME_ALICE, CLAIMER, want);
    const code = await ethers.provider.getCode(want);
    expect(ethers.dataLength(code)).to.equal(0x2d + 52);
    expect(ethers.dataSlice(code, 0x2d)).to.equal(cloneArgs(HOME_ALICE, CLAIMER).toLowerCase());
    const proxy = await ethers.getContractAt("SaleVaultProxy", want);
    expect(await proxy.home()).to.equal(HOME_ALICE);
    expect(await proxy.claimer()).to.equal(CLAIMER);
  });

  it("deploy is idempotent", async () => {
    const s = await loadFixture(deploySystem);
    await s.factory.deploy(HOME_AB, CLAIMER);
    await expect(s.factory.deploy(HOME_AB, CLAIMER)).to.not.emit(s.factory, "ProxyDeployed");
  });
});
