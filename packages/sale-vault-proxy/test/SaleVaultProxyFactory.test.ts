import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  CF_BLOCK_SECONDS,
  MAX_BACKOFF_SHIFT,
  factoryConfig,
  type SaleVaultProxyNetwork,
} from "../config/networks";
import {
  CLAIMER,
  FAR_DEADLINE,
  SRC_ADDR,
  SRC_CHAIN,
  TEST_NETWORK,
  claimerOf,
  deliver,
  deployMocks,
  deploySystem,
  encodeMessage,
  homeOf,
  predictProxy,
  proxyAt,
  refOf,
  sell,
  type System,
} from "./helpers";
import { deferFloor, intrinsicGas, mockRig, receive } from "./measure";

const reason = (s: string) => ethers.encodeBytes32String(s);
const DAY = 86_400n;

// A cfReceive gas limit that leaves less than DELIVERY_GAS at the check but books the deferral
async function lowGas(s: System, message: string, amount: bigint) {
  const data = s.factory.interface.encodeFunctionData("cfReceive", [
    SRC_CHAIN,
    SRC_ADDR,
    message,
    await s.usdc.getAddress(),
    amount,
  ]);
  return intrinsicGas(data) + (await deferFloor(mockRig(s))) + 5_000n;
}

// A sale delivered by someone who chose too little gas, deferred with its terms
async function deferredSale() {
  const s = await deploySystem();
  const home = homeOf("deferred");
  const ref = refOf("deferred");
  const msg = encodeMessage(ref, s.recipient.address, 50_000_000n, home);
  await receive(mockRig(s), msg, 50_500_000n, await lowGas(s, msg, 50_500_000n));
  return { s, home, ref, msg };
}

describe("SaleVaultProxyFactory", () => {
  describe("constructor", () => {
    it("stores the immutables and deploys the implementation at nonce 1", async () => {
      const s = await loadFixture(deploySystem);
      const factory = await s.factory.getAddress();
      expect(await s.factory.VAULT()).to.equal(await s.vault.getAddress());
      expect(await s.factory.USDC()).to.equal(await s.usdc.getAddress());
      expect(await s.factory.TREASURY()).to.equal(s.treasury.address);
      expect(await s.factory.GUARDIAN()).to.equal(s.guardian.address);
      expect(await s.factory.retired()).to.equal(false);
      expect(await s.factory.IMPLEMENTATION()).to.equal(
        ethers.getCreateAddress({ from: factory, nonce: 1 }),
      );
      const impl = s.implementation;
      expect(await impl.FACTORY()).to.equal(factory);
      expect(await impl.USDC()).to.equal(await s.usdc.getAddress());
      expect(await impl.VAULT()).to.equal(await s.vault.getAddress());
      expect(await impl.BROKER()).to.equal(s.net.broker);
      expect(await impl.HOME_CHAIN()).to.equal(6);
      expect(await impl.HOME_TOKEN()).to.equal(12);
      expect(await impl.RETRY_BLOCKS()).to.equal(s.net.retryBlocks);
      expect(await impl.MIN_RETURN()).to.equal(s.net.minReturn);
      expect(await impl.MAX_RETURN()).to.equal(s.net.maxReturn);
      expect(await impl.PRICE_FLOOR_BPS()).to.equal(s.net.priceFloorBps);
      expect(await impl.FEE_ALLOWANCE()).to.equal(s.net.feeAllowance);
      expect(await impl.RETURN_COOLDOWN()).to.equal(s.net.returnCooldown);
      expect(await impl.RELEASE_DELAY()).to.equal(s.net.releaseDelay);
      expect(await impl.RELEASE_ATTEMPTS()).to.equal(s.net.releaseAttempts);
      expect(await impl.STALE_DELAY()).to.equal(s.net.staleDelay);
      expect(await impl.TREASURY()).to.equal(s.treasury.address);
    });

    it("refuses zero addresses, a zero guardian and a zero broker", async () => {
      const [, treasury, , , guardian] = await ethers.getSigners();
      const { usdc, vault } = await deployMocks();
      const Factory = await ethers.getContractFactory("SaleVaultProxyFactory");
      const net: SaleVaultProxyNetwork = {
        ...TEST_NETWORK,
        vault: await vault.getAddress(),
        usdc: await usdc.getAddress(),
      };
      const bad: [Partial<SaleVaultProxyNetwork>, string, string][] = [
        [{ vault: ethers.ZeroAddress }, treasury.address, guardian.address],
        [{ usdc: ethers.ZeroAddress }, treasury.address, guardian.address],
        [{}, ethers.ZeroAddress, guardian.address],
        [{}, treasury.address, ethers.ZeroAddress],
        [{ broker: ethers.ZeroHash }, treasury.address, guardian.address],
      ];
      for (const [o, t, g] of bad) {
        await expect(
          Factory.deploy(factoryConfig({ ...net, ...o }, t, g)),
        ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
      }
    });

    it("refuses each out-of-bounds setting and accepts each bound", async () => {
      const [, treasury] = await ethers.getSigners();
      const { usdc, vault } = await deployMocks();
      const Factory = await ethers.getContractFactory("SaleVaultProxyFactory");
      const net: SaleVaultProxyNetwork = {
        ...TEST_NETWORK,
        vault: await vault.getAddress(),
        usdc: await usdc.getAddress(),
      };
      const floor = net.minDeposit + 2n * net.refundFee;
      const bad: Partial<SaleVaultProxyNetwork>[] = [
        { homeChain: 0 },
        { homeToken: 0 },
        { retryBlocks: 0 },
        { retryBlocks: 601 },
        { priceFloorBps: 9499n },
        { priceFloorBps: 10_001n },
        { refundFee: 0n },
        { minReturn: floor },
        { feeAllowance: (net.minReturn * net.priceFloorBps) / 10_000n },
        { maxReturn: 2n * net.minReturn - 1n },
        { maxReturn: 0n },
        { returnCooldown: 0n },
        { returnCooldown: DAY + 1n },
        { releaseDelay: BigInt(net.retryBlocks) * CF_BLOCK_SECONDS - 1n },
        { releaseDelay: net.staleDelay + 1n },
        { staleDelay: net.returnCooldown << MAX_BACKOFF_SHIFT },
        { returnCooldown: net.staleDelay >> MAX_BACKOFF_SHIFT },
        { staleDelay: 90n * DAY + 1n },
        { releaseAttempts: 0n },
        { releaseAttempts: 256n },
      ];
      for (const o of bad) {
        await expect(
          Factory.deploy(factoryConfig({ ...net, ...o }, treasury.address, treasury.address)),
          JSON.stringify(o, (_, v) => (typeof v === "bigint" ? String(v) : v)),
        ).to.be.revertedWithCustomError(Factory, "BadConfig");
      }
      const ok: Partial<SaleVaultProxyNetwork>[] = [
        { retryBlocks: 1 },
        { retryBlocks: 600 },
        { priceFloorBps: 9500n },
        { priceFloorBps: 10_000n },
        { minReturn: floor + 1n },
        { maxReturn: 2n * net.minReturn },
        { returnCooldown: DAY, staleDelay: 90n * DAY },
        { releaseDelay: BigInt(net.retryBlocks) * CF_BLOCK_SECONDS },
        { releaseDelay: net.staleDelay },
        {
          staleDelay: (net.returnCooldown << MAX_BACKOFF_SHIFT) + 1n,
          releaseDelay: net.returnCooldown,
        },
        { staleDelay: 90n * DAY },
        { releaseAttempts: 1n },
        { releaseAttempts: 255n },
      ];
      for (const o of ok) {
        await expect(
          Factory.deploy(factoryConfig({ ...net, ...o }, treasury.address, treasury.address)),
          JSON.stringify(o, (_, v) => (typeof v === "bigint" ? String(v) : v)),
        ).to.not.be.reverted;
      }
    });
  });

  describe("cfReceive", () => {
    it("refuses a caller that is not the Vault", async () => {
      const s = await loadFixture(deploySystem);
      const msg = encodeMessage(refOf("a"), s.recipient.address, 1n, homeOf("a"));
      await expect(
        s.factory
          .connect(s.stranger)
          .cfReceive(SRC_CHAIN, SRC_ADDR, msg, await s.usdc.getAddress(), 1n),
      ).to.be.revertedWithCustomError(s.factory, "NotVault");
    });

    it("flags a wrong token, a bad length, a zero home and a zero or dirty claimer without pending", async () => {
      const s = await loadFixture(deploySystem);
      const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await other.mint(await s.vault.getAddress(), 1_000_000n);
      const msg = encodeMessage(refOf("x"), s.recipient.address, 100n, homeOf("x"));
      await expect(deliver(s, msg, 100n, { token: await other.getAddress() }))
        .to.emit(s.factory, "Unattributed")
        .withArgs(await other.getAddress(), 100n, reason("token"));
      for (const bad of [
        "0xdeadbeef",
        ethers.dataSlice(msg, 0, 160),
        ethers.concat([msg, "0x00"]),
      ]) {
        await expect(deliver(s, bad, 100n))
          .to.emit(s.factory, "Unattributed")
          .withArgs(await s.usdc.getAddress(), 100n, reason("message"));
      }
      const zero = encodeMessage(refOf("z"), s.recipient.address, 100n, ethers.ZeroHash);
      await expect(deliver(s, zero, 100n))
        .to.emit(s.factory, "Unattributed")
        .withArgs(await s.usdc.getAddress(), 100n, reason("home"));
      const dirty = ethers.concat([
        ethers.dataSlice(msg, 0, 160),
        "0x01" + "00".repeat(11) + CLAIMER.slice(2),
      ]);
      for (const bad of [
        encodeMessage(
          refOf("c"),
          s.recipient.address,
          100n,
          homeOf("c"),
          FAR_DEADLINE,
          ethers.ZeroAddress,
        ),
        dirty,
      ]) {
        await expect(deliver(s, bad, 100n))
          .to.emit(s.factory, "Unattributed")
          .withArgs(await s.usdc.getAddress(), 100n, reason("claimer"));
      }
      expect(await s.factory.totalPending()).to.equal(0n);
      expect(await s.usdc.balanceOf(await s.factory.getAddress())).to.equal(600n);
      await s.factory.skim();
      expect(await s.usdc.balanceOf(s.treasury.address)).to.equal(600n);
    });

    it("deploys a fresh home's proxy and the proxy pays the recipient", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("fresh");
      const proxy = predictProxy(
        await s.factory.getAddress(),
        await s.factory.IMPLEMENTATION(),
        home,
        CLAIMER,
      );
      const tx = deliver(
        s,
        encodeMessage(refOf("fresh"), s.recipient.address, 50_000_000n, home),
        50_300_000n,
      );
      await expect(tx).to.emit(s.factory, "ProxyDeployed").withArgs(home, CLAIMER, proxy);
      await expect(tx)
        .to.emit(s.factory, "Delivered")
        .withArgs(
          home,
          proxy,
          refOf("fresh"),
          CLAIMER,
          s.recipient.address,
          50_000_000n,
          50_300_000n,
        );
      await expect(tx)
        .to.emit(s.usdc, "Transfer")
        .withArgs(proxy, s.recipient.address, 50_000_000n);
      expect(await s.usdc.balanceOf(proxy)).to.equal(300_000n);
      expect(await s.usdc.balanceOf(await s.factory.getAddress())).to.equal(0n);
    });

    it("reuses a proxy deployed in advance, even by a front-runner", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("pre");
      await s.factory.connect(s.stranger).deploy(home, CLAIMER);
      const tx = deliver(
        s,
        encodeMessage(refOf("pre"), s.recipient.address, 50_000_000n, home),
        50_000_000n,
      );
      await expect(tx).to.not.emit(s.factory, "ProxyDeployed");
      await expect(tx).to.emit(s.factory, "Delivered");
      const proxy = await proxyAt(s, home);
      const [status] = await proxy.delivery(refOf("pre"), s.recipient.address, 50_000_000n);
      expect(status).to.equal(1n);
    });

    it("pays a second sale on the same home", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "first", 50_000_000n, 50_000_000n);
      const second = ethers.Wallet.createRandom().address;
      await expect(
        deliver(s, encodeMessage(refOf("second"), second, 30_000_000n, home), 30_000_000n),
      )
        .to.emit(proxy, "SalePaid")
        .withArgs(refOf("second"), second, 30_000_000n, 0n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      expect(await s.usdc.balanceOf(second)).to.equal(30_000_000n);
    });

    it("leaves a repeat of a paid sale's exact terms on the proxy as extra", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "twice", 50_000_000n, 50_000_000n);
      const msg = encodeMessage(refOf("twice"), s.recipient.address, 50_000_000n, home);
      await expect(deliver(s, msg, 30_000_000n))
        .to.emit(proxy, "ExtraDelivery")
        .withArgs(refOf("twice"), s.recipient.address, 50_000_000n, 30_000_000n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(30_000_000n);
      const [status, amount, leftover] = await proxy.delivery(
        refOf("twice"),
        s.recipient.address,
        50_000_000n,
      );
      expect([status, amount, leftover]).to.deep.equal([1n, 80_000_000n, 0n]);
    });

    describe("a foreign CCM naming a victim's home", () => {
      const COMMITTED = 50_000_000n;

      it("with its own ref pays only its own recipient, and the real sale still pays", async () => {
        const s = await loadFixture(deploySystem);
        const home = homeOf("victim");
        const attacker = s.stranger.address;
        await deliver(s, encodeMessage(refOf("spoof"), attacker, 10_000_000n, home), 10_000_000n);
        expect(await s.usdc.balanceOf(attacker)).to.equal(10_000_000n);
        const proxy = await proxyAt(s, home);
        await expect(
          deliver(
            s,
            encodeMessage(refOf("victim"), s.recipient.address, COMMITTED, home),
            COMMITTED,
          ),
        )
          .to.emit(proxy, "SalePaid")
          .withArgs(refOf("victim"), s.recipient.address, COMMITTED, 0n);
        expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(COMMITTED);
        expect(await s.usdc.balanceOf(attacker)).to.equal(10_000_000n);
      });

      it("with a copied ref and its own recipient cannot take the real sale's booking", async () => {
        const s = await loadFixture(deploySystem);
        const home = homeOf("victim");
        const attacker = s.stranger.address;
        await deliver(s, encodeMessage(refOf("victim"), attacker, 1n, home), 1n);
        await deliver(
          s,
          encodeMessage(refOf("victim"), s.recipient.address, COMMITTED, home),
          COMMITTED,
        );
        expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(COMMITTED);
        expect(await s.usdc.balanceOf(attacker)).to.equal(1n);
      });

      it("as a short copy of the exact terms is held, and the real sale still pays", async () => {
        const s = await loadFixture(deploySystem);
        const home = homeOf("victim");
        const msg = encodeMessage(refOf("victim"), s.recipient.address, COMMITTED, home);
        const proxy = await proxyAt(s, home);
        await expect(deliver(s, msg, 1_000_000n)).to.emit(proxy, "SaleHeld");
        await expect(deliver(s, msg, COMMITTED)).to.emit(proxy, "SalePaid");
        expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(COMMITTED);
        expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(1_000_000n);
      });
    });

    it("defers a delivery below DELIVERY_GAS with its terms and never reverts", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      expect(
        await s.factory.pendingDelivery(
          home,
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.equal(50_500_000n);
      expect(await s.factory.pending(home, CLAIMER)).to.equal(0n);
      expect(await s.factory.totalPending()).to.equal(50_500_000n);
      expect(await ethers.provider.getCode(await s.factory.predict(home, CLAIMER))).to.equal("0x");
    });

    it("emits the deferral with every term deliver needs", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("emit");
      const msg = encodeMessage(refOf("emit"), s.recipient.address, 50_000_000n, home);
      await expect(receive(mockRig(s), msg, 50_000_000n, await lowGas(s, msg, 50_000_000n)))
        .to.emit(s.factory, "DeliveryDeferred")
        .withArgs(
          home,
          CLAIMER,
          refOf("emit"),
          s.recipient.address,
          50_000_000n,
          50_000_000n,
          FAR_DEADLINE,
        );
    });

    it("pays when just above DELIVERY_GAS", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("edge");
      const msg = encodeMessage(refOf("edge"), s.recipient.address, 50_000_000n, home);
      const data = s.factory.interface.encodeFunctionData("cfReceive", [
        SRC_CHAIN,
        SRC_ADDR,
        msg,
        await s.usdc.getAddress(),
        50_000_000n,
      ]);
      const limit = intrinsicGas(data) + (await s.factory.DELIVERY_GAS()) + 10_000n;
      await expect(receive(mockRig(s), msg, 50_000_000n, limit)).to.emit(s.factory, "Delivered");
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
    });

    it("books funds-only pending when USDC refuses the move into the proxy", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("frozen");
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), true);
      await expect(deliver(s, encodeMessage(refOf("frozen"), s.recipient.address, 5n, home), 5n))
        .to.emit(s.factory, "DeliveryPending")
        .withArgs(home, CLAIMER, refOf("frozen"), 5n, reason("transfer"));
      expect(await s.factory.pending(home, CLAIMER)).to.equal(5n);
    });

    it("leaves the USDC unbooked on the proxy when onDelivery reverts", async () => {
      const [, treasury, recipient] = await ethers.getSigners();
      const { usdc, vault } = await deployMocks();
      const net = {
        ...TEST_NETWORK,
        vault: await vault.getAddress(),
        usdc: await usdc.getAddress(),
      };
      const factory = await (
        await ethers.getContractFactory("RevertingSaleVaultProxyFactory")
      ).deploy(factoryConfig(net, treasury.address, treasury.address));
      const home = homeOf("unbooked");
      const proxy = await factory.predict(home, CLAIMER);
      const msg = encodeMessage(refOf("unbooked"), recipient.address, 5n, home);
      await expect(
        vault.deliver(
          await factory.getAddress(),
          SRC_CHAIN,
          SRC_ADDR,
          msg,
          await usdc.getAddress(),
          5n,
        ),
      )
        .to.emit(factory, "DeliveryUnbooked")
        .withArgs(home, proxy, refOf("unbooked"), CLAIMER, 5n);
      expect(await usdc.balanceOf(proxy)).to.equal(5n);
      expect(await usdc.balanceOf(recipient.address)).to.equal(0n);
    });
  });

  describe("deliver", () => {
    it("pays a gas-deferred sale exactly once, from anyone", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      const proxy = await proxyAt(s, home);
      await expect(
        s.factory
          .connect(s.stranger)
          .deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE),
      )
        .to.emit(proxy, "SalePaid")
        .withArgs(ref, s.recipient.address, 50_000_000n, 500_000n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      expect(await s.factory.totalPending()).to.equal(0n);
      expect(
        await s.factory.pendingDelivery(
          home,
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.equal(0n);
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
    });

    it("cannot be flushed, so a deferred sale is never sent home unpaid", async () => {
      const { s, home } = await loadFixture(deferredSale);
      await expect(s.factory.flush(home, CLAIMER)).to.be.revertedWithCustomError(
        s.factory,
        "NothingPending",
      );
      expect(await s.factory.totalPending()).to.equal(50_500_000n);
    });

    it("refuses other terms and keeps the deferred sale", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.stranger.address, 50_000_000n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 1n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
      await expect(
        s.factory.deliver(
          homeOf("other"),
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE - 1n),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
    });

    it("reverts whole when called short of DELIVERY_GAS", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      const data = s.factory.interface.encodeFunctionData("deliver", [
        home,
        CLAIMER,
        ref,
        s.recipient.address,
        50_000_000n,
        FAR_DEADLINE,
      ]);
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE, {
          gasLimit: intrinsicGas(data) + 100_000n,
        }),
      ).to.be.revertedWithCustomError(s.factory, "NotEnoughGas");
      expect(
        await s.factory.pendingDelivery(
          home,
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.equal(50_500_000n);
    });

    it("adds up deferred copies of the same terms and pays once", async () => {
      const { s, home, ref, msg } = await loadFixture(deferredSale);
      await receive(mockRig(s), msg, 1_000_000n, await lowGas(s, msg, 1_000_000n));
      expect(
        await s.factory.pendingDelivery(
          home,
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.equal(51_500_000n);
      await s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      expect(await s.usdc.balanceOf(await s.factory.predict(home, CLAIMER))).to.equal(1_500_000n);
    });

    it("holds a deferred sale delivered after its deadline and pays nothing", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("late-deferred");
      const ref = refOf("late-deferred");
      const deadline = BigInt(await time.latest()) + 3600n;
      const msg = encodeMessage(ref, s.recipient.address, 50_000_000n, home, deadline);
      await receive(mockRig(s), msg, 50_500_000n, await lowGas(s, msg, 50_500_000n));
      await time.increaseTo(deadline + 1n);
      const proxy = await proxyAt(s, home);
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, deadline),
      )
        .to.emit(proxy, "SaleHeld")
        .withArgs(ref, s.recipient.address, 50_000_000n, 50_500_000n, reason("expired"));
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(0n);
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(50_500_000n);
      expect(await s.factory.totalPending()).to.equal(0n);
    });

    it("keeps a copy with another deadline apart, so it cannot void the live sale", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      const msg = encodeMessage(ref, s.recipient.address, 50_000_000n, home, 1n);
      await expect(receive(mockRig(s), msg, 1_000_000n, await lowGas(s, msg, 1_000_000n)))
        .to.emit(s.factory, "DeliveryDeferred")
        .withArgs(home, CLAIMER, ref, s.recipient.address, 50_000_000n, 1_000_000n, 1n);
      expect(
        await s.factory.pendingDelivery(
          home,
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.equal(50_500_000n);
      expect(
        await s.factory.pendingDelivery(home, CLAIMER, ref, s.recipient.address, 50_000_000n, 1n),
      ).to.equal(1_000_000n);
      const proxy = await proxyAt(s, home);
      await expect(s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, 1n))
        .to.emit(proxy, "SaleHeld")
        .withArgs(ref, s.recipient.address, 50_000_000n, 1_000_000n, reason("expired"));
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE),
      )
        .to.emit(proxy, "SalePaid")
        .withArgs(ref, s.recipient.address, 50_000_000n, 500_000n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      expect(await s.factory.totalPending()).to.equal(0n);
    });

    it("reverts and keeps the terms while USDC is paused, then pays once it resumes", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      await s.usdc.setPaused(true);
      await expect(
        s.factory
          .connect(s.stranger)
          .deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE),
      ).to.be.revertedWithCustomError(s.factory, "TransferFailed");
      await s.usdc.setPaused(false);
      expect(
        await s.factory.pendingDelivery(
          home,
          CLAIMER,
          ref,
          s.recipient.address,
          50_000_000n,
          FAR_DEADLINE,
        ),
      ).to.equal(50_500_000n);
      expect(await s.factory.pending(home, CLAIMER)).to.equal(0n);
      await expect(
        s.factory.deliver(home, CLAIMER, ref, s.recipient.address, 50_000_000n, FAR_DEADLINE),
      ).to.emit(await proxyAt(s, home), "SalePaid");
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      expect(await s.factory.totalPending()).to.equal(0n);
    });
  });

  describe("flush", () => {
    async function pendingSale() {
      const s = await deploySystem();
      const home = homeOf("pend");
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), true);
      await deliver(
        s,
        encodeMessage(refOf("pend"), s.recipient.address, 30_000_000n, home),
        30_000_000n,
      );
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), false);
      return { s, home };
    }

    it("moves pending into the deployed proxy without paying the provider", async () => {
      const { s, home } = await loadFixture(pendingSale);
      const proxy = await s.factory.predict(home, CLAIMER);
      await expect(s.factory.connect(s.stranger).flush(home, CLAIMER))
        .to.emit(s.factory, "PendingFlushed")
        .withArgs(home, CLAIMER, proxy, 30_000_000n);
      expect(await s.factory.pending(home, CLAIMER)).to.equal(0n);
      expect(await s.factory.totalPending()).to.equal(0n);
      expect(await s.usdc.balanceOf(proxy)).to.equal(30_000_000n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(0n);
      const p = await ethers.getContractAt("SaleVaultProxy", proxy);
      const [status] = await p.delivery(refOf("pend"), s.recipient.address, 30_000_000n);
      expect(status).to.equal(0n);
    });

    it("refuses a home with nothing pending", async () => {
      const { s, home } = await loadFixture(pendingSale);
      await s.factory.flush(home, CLAIMER);
      await expect(s.factory.flush(home, CLAIMER)).to.be.revertedWithCustomError(
        s.factory,
        "NothingPending",
      );
    });

    it("keeps totalPending consistent across homes", async () => {
      const { s, home } = await loadFixture(pendingSale);
      const other = homeOf("pend2");
      await s.usdc.setBlocked(await s.factory.predict(other, CLAIMER), true);
      await deliver(s, encodeMessage(refOf("pend2"), s.recipient.address, 7n, other), 7n);
      expect(await s.factory.totalPending()).to.equal(30_000_007n);
      await s.factory.flush(home, CLAIMER);
      expect(await s.factory.totalPending()).to.equal(7n);
    });
  });

  describe("skims", () => {
    it("skim sends only the free balance to the treasury, never pending or deferred", async () => {
      const { s } = await loadFixture(deferredSale);
      const home = homeOf("held");
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), true);
      await deliver(s, encodeMessage(refOf("held"), s.recipient.address, 9n, home), 9n);
      await expect(s.factory.skim()).to.be.revertedWithCustomError(s.factory, "NothingToSkim");
      await s.usdc.mint(await s.factory.getAddress(), 4n);
      await expect(s.factory.connect(s.stranger).skim())
        .to.emit(s.factory, "Skimmed")
        .withArgs(await s.usdc.getAddress(), s.treasury.address, 4n);
      expect(await s.usdc.balanceOf(s.treasury.address)).to.equal(4n);
      expect(await s.usdc.balanceOf(await s.factory.getAddress())).to.equal(50_500_009n);
    });

    it("skimToken refuses USDC and moves another token to the treasury", async () => {
      const s = await loadFixture(deploySystem);
      await expect(s.factory.skimToken(await s.usdc.getAddress())).to.be.revertedWithCustomError(
        s.factory,
        "CannotSkimUSDC",
      );
      const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await other.mint(await s.factory.getAddress(), 11n);
      await s.factory.skimToken(await other.getAddress());
      expect(await other.balanceOf(s.treasury.address)).to.equal(11n);
    });

    it("skimNative moves ETH a payable delivery left", async () => {
      const s = await loadFixture(deploySystem);
      await s.vault.deliver(
        await s.factory.getAddress(),
        SRC_CHAIN,
        SRC_ADDR,
        encodeMessage(refOf("eth"), s.recipient.address, 5n, homeOf("eth")),
        await s.usdc.getAddress(),
        5n,
        { value: ethers.parseEther("1") },
      );
      const before = await ethers.provider.getBalance(s.treasury.address);
      await s.factory.connect(s.stranger).skimNative();
      expect(await ethers.provider.getBalance(s.treasury.address)).to.equal(
        before + ethers.parseEther("1"),
      );
    });
  });

  describe("claimer binding", () => {
    const OTHER = claimerOf("attacker");

    it("gives the same home a separate proxy per claimer, and predict and deploy refuse claimer 0", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("bound");
      const mine = await s.factory.predict(home, CLAIMER);
      const theirs = await s.factory.predict(home, OTHER);
      expect(mine).to.not.equal(theirs);
      await expect(s.factory.predict(home, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        s.factory,
        "ZeroAddress",
      );
      await expect(s.factory.deploy(home, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        s.factory,
        "ZeroAddress",
      );
    });

    it("a forged CCM with the victim's home and its own claimer funds only its own proxy", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("victim");
      const msg = (claimer: string) =>
        encodeMessage(
          refOf("victim"),
          s.recipient.address,
          50_000_000n,
          home,
          FAR_DEADLINE,
          claimer,
        );
      await deliver(s, msg(OTHER), 10_000_000n);
      await deliver(s, msg(CLAIMER), 40_000_000n);
      expect(await s.usdc.balanceOf(await s.factory.predict(home, OTHER))).to.equal(10_000_000n);
      expect(await s.usdc.balanceOf(await s.factory.predict(home, CLAIMER))).to.equal(40_000_000n);
      expect(await (await proxyAt(s, home, OTHER)).claimer()).to.equal(OTHER);
    });

    it("keeps same terms with another claimer as a separate deferred entry, deliver with the wrong claimer finds nothing", async () => {
      const { s, home, ref } = await loadFixture(deferredSale);
      const msg = encodeMessage(ref, s.recipient.address, 50_000_000n, home, FAR_DEADLINE, OTHER);
      await receive(mockRig(s), msg, 1_000_000n, await lowGas(s, msg, 1_000_000n));
      const terms = [ref, s.recipient.address, 50_000_000n, FAR_DEADLINE] as const;
      expect(await s.factory.pendingDelivery(home, CLAIMER, ...terms)).to.equal(50_500_000n);
      expect(await s.factory.pendingDelivery(home, OTHER, ...terms)).to.equal(1_000_000n);
      const third = claimerOf("third");
      await expect(s.factory.deliver(home, third, ...terms)).to.be.revertedWithCustomError(
        s.factory,
        "NothingPending",
      );
      await s.factory.deliver(home, OTHER, ...terms);
      expect(await s.factory.pendingDelivery(home, CLAIMER, ...terms)).to.equal(50_500_000n);
      expect(await s.usdc.balanceOf(await s.factory.predict(home, OTHER))).to.equal(1_000_000n);
      expect(await s.factory.totalPending()).to.equal(50_500_000n);
    });

    it("keeps same home with another claimer as a separate pending entry, flush with the wrong claimer finds nothing", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("pend-bound");
      for (const [claimer, amount] of [
        [CLAIMER, 30n],
        [OTHER, 7n],
      ] as const) {
        await s.usdc.setBlocked(await s.factory.predict(home, claimer), true);
        await deliver(
          s,
          encodeMessage(refOf("p"), s.recipient.address, 5n, home, FAR_DEADLINE, claimer),
          amount,
        );
      }
      expect(await s.factory.pending(home, CLAIMER)).to.equal(30n);
      expect(await s.factory.pending(home, OTHER)).to.equal(7n);
      await expect(s.factory.flush(home, claimerOf("third"))).to.be.revertedWithCustomError(
        s.factory,
        "NothingPending",
      );
      await s.factory.flush(home, OTHER);
      expect(await s.usdc.balanceOf(OTHER)).to.equal(7n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(0n);
      expect(await s.factory.pending(home, CLAIMER)).to.equal(30n);
      expect(await s.factory.totalPending()).to.equal(30n);
    });
  });

  describe("retire", () => {
    it("is guardian only, one-way, and emits Retired", async () => {
      const s = await loadFixture(deploySystem);
      await expect(s.factory.connect(s.stranger).retire()).to.be.revertedWithCustomError(
        s.factory,
        "NotGuardian",
      );
      await expect(s.factory.connect(s.treasury).retire()).to.be.revertedWithCustomError(
        s.factory,
        "NotGuardian",
      );
      await expect(s.factory.connect(s.guardian).retire()).to.emit(s.factory, "Retired");
      expect(await s.factory.retired()).to.equal(true);
      await expect(s.factory.connect(s.guardian).retire()).to.be.revertedWithCustomError(
        s.factory,
        "AlreadyRetired",
      );
    });

    it("still books deliveries and pays providers after retire, held funds release to the claimer", async () => {
      const s = await loadFixture(deploySystem);
      await s.factory.connect(s.guardian).retire();
      const { proxy } = await sell(s, "after", 50_000_000n, 50_400_000n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
      await expect(proxy.returnHome()).to.be.revertedWithCustomError(proxy, "FactoryRetired");
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(400_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(400_000n);
    });

    it("gives the guardian no way to move funds or pick a destination", async () => {
      const s = await loadFixture(deploySystem);
      const guardianOnly = s.factory.interface.fragments.filter(
        (f) => f.type === "function" && "name" in f && (f as { name: string }).name === "retire",
      );
      expect(guardianOnly.length).to.equal(1);
      const { proxy } = await sell(s, "g", 50_000_000n, 40_000_000n);
      await s.factory.connect(s.guardian).retire();
      await proxy.connect(s.guardian).release();
      expect(await s.usdc.balanceOf(s.guardian.address)).to.equal(0n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(40_000_000n);
    });
  });

  describe("expireDeferred", () => {
    async function lateDeferred() {
      const s = await deploySystem();
      const home = homeOf("expire");
      const ref = refOf("expire");
      const deadline = BigInt(await time.latest()) + 3600n;
      const msg = encodeMessage(ref, s.recipient.address, 50_000_000n, home, deadline);
      await receive(mockRig(s), msg, 50_500_000n, await lowGas(s, msg, 50_500_000n));
      const terms = [ref, s.recipient.address, 50_000_000n, deadline] as const;
      return { s, home, terms, deadline };
    }

    it("refuses at the deadline and moves the entry to pending strictly after it, from anyone", async () => {
      const { s, home, terms, deadline } = await loadFixture(lateDeferred);
      await time.setNextBlockTimestamp(deadline);
      await expect(s.factory.expireDeferred(home, CLAIMER, ...terms))
        .to.be.revertedWithCustomError(s.factory, "NotExpired")
        .withArgs(deadline);
      await time.setNextBlockTimestamp(deadline + 1n);
      await expect(s.factory.connect(s.stranger).expireDeferred(home, CLAIMER, ...terms))
        .to.emit(s.factory, "DeferredExpired")
        .withArgs(home, CLAIMER, ...terms.slice(0, 3), 50_500_000n, deadline);
      expect(await s.factory.pendingDelivery(home, CLAIMER, ...terms)).to.equal(0n);
      expect(await s.factory.pending(home, CLAIMER)).to.equal(50_500_000n);
      expect(await s.factory.totalPending()).to.equal(50_500_000n);
      await expect(s.factory.expireDeferred(home, CLAIMER, ...terms)).to.be.revertedWithCustomError(
        s.factory,
        "NothingPending",
      );
      await s.factory.flush(home, CLAIMER);
      expect(await s.usdc.balanceOf(await s.factory.predict(home, CLAIMER))).to.equal(50_500_000n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(0n);
      expect(await s.factory.totalPending()).to.equal(0n);
    });

    it("finds nothing under another claimer or other terms", async () => {
      const { s, home, terms, deadline } = await loadFixture(lateDeferred);
      await time.increaseTo(deadline + 1n);
      await expect(
        s.factory.expireDeferred(home, claimerOf("attacker"), ...terms),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
      await expect(
        s.factory.expireDeferred(home, CLAIMER, terms[0], terms[1], 1n, deadline),
      ).to.be.revertedWithCustomError(s.factory, "NothingPending");
      expect(await s.factory.pendingDelivery(home, CLAIMER, ...terms)).to.equal(50_500_000n);
    });
  });

  describe("flush fallback", () => {
    async function blockedProxyPending() {
      const s = await deploySystem();
      const home = homeOf("fallback");
      const proxy = await s.factory.predict(home, CLAIMER);
      await s.usdc.setBlocked(proxy, true);
      await deliver(s, encodeMessage(refOf("fb"), s.recipient.address, 5n, home), 30_000_000n);
      return { s, home, proxy };
    }

    it("pays the claimer when USDC refuses the proxy", async () => {
      const { s, home } = await loadFixture(blockedProxyPending);
      await expect(s.factory.connect(s.stranger).flush(home, CLAIMER))
        .to.emit(s.factory, "PendingFlushed")
        .withArgs(home, CLAIMER, CLAIMER, 30_000_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(30_000_000n);
      expect(await s.factory.totalPending()).to.equal(0n);
    });

    it("reverts and keeps the credit when the claimer is refused too", async () => {
      const { s, home } = await loadFixture(blockedProxyPending);
      await s.usdc.setBlocked(CLAIMER, true);
      await expect(s.factory.flush(home, CLAIMER)).to.be.revertedWith("USDC: recipient blocked");
      expect(await s.factory.pending(home, CLAIMER)).to.equal(30_000_000n);
      expect(await s.factory.totalPending()).to.equal(30_000_000n);
    });

    it("reverts below the gas floor so a starved call cannot divert to the claimer", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("floor");
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), true);
      await deliver(s, encodeMessage(refOf("fl"), s.recipient.address, 5n, home), 9n);
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), false);
      const data = s.factory.interface.encodeFunctionData("flush", [home, CLAIMER]);
      await expect(
        s.factory.flush(home, CLAIMER, { gasLimit: intrinsicGas(data) + 100_000n }),
      ).to.be.revertedWithCustomError(s.factory, "NotEnoughGas");
      expect(await s.factory.pending(home, CLAIMER)).to.equal(9n);
    });
  });
});
