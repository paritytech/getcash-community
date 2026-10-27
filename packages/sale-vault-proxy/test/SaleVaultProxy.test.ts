import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { factoryConfig } from "../config/networks";
import {
  CLAIMER,
  FAR_DEADLINE,
  TEST_NETWORK,
  deliver,
  deployMocks,
  deploySystem,
  encodeCfParameters,
  encodeMessage,
  homeOf,
  minPriceX128,
  proxyAt,
  refOf,
  sell,
  type System,
} from "./helpers";
import { asSigner } from "./measure";

const reason = (s: string) => ethers.encodeBytes32String(s);
const MIN = TEST_NETWORK.minReturn;
const MAX = TEST_NETWORK.maxReturn;
const COOLDOWN = TEST_NETWORK.returnCooldown;
const RELEASE_DELAY = TEST_NETWORK.releaseDelay;
const RELEASE_ATTEMPTS = TEST_NETWORK.releaseAttempts;
const STALE_DELAY = TEST_NETWORK.staleDelay;

async function asFactory(s: System) {
  return asSigner(await s.factory.getAddress());
}

// A held sale with a returnable balance
async function heldSale() {
  const s = await deploySystem();
  const { home, proxy } = await sell(s, "held", 50_000_000n, 40_000_000n);
  return { s, home, proxy };
}

// Sends the next return as soon as its backoff allows
async function returnWhenDue(proxy: Awaited<ReturnType<typeof proxyAt>>) {
  const due = await proxy.nextReturnAt();
  if (due > BigInt(await time.latest())) await time.setNextBlockTimestamp(due);
  await proxy.returnHome();
}

// The sale's record by its terms, as numbers
async function record(
  proxy: Awaited<ReturnType<typeof proxyAt>>,
  id: string,
  r: string,
  c: bigint,
) {
  const [status, amount, leftover] = await proxy.delivery(refOf(id), r, c);
  return { status, amount, leftover };
}

describe("SaleVaultProxy", () => {
  describe("onDelivery", () => {
    it("is factory only, on a proxy and on the implementation", async () => {
      const s = await loadFixture(deploySystem);
      await s.factory.deploy(homeOf("only"), CLAIMER);
      const proxy = await proxyAt(s, homeOf("only"));
      const args = [refOf("only"), s.recipient.address, 1n, 1n, FAR_DEADLINE] as const;
      await expect(proxy.connect(s.stranger).onDelivery(...args)).to.be.revertedWithCustomError(
        proxy,
        "NotFactory",
      );
      await expect(
        s.implementation.connect(s.stranger).onDelivery(...args),
      ).to.be.revertedWithCustomError(s.implementation, "NotFactory");
    });

    it("pays the exact committed amount and records the sale's leftover", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("paid");
      const proxy = await proxyAt(s, home);
      await expect(
        deliver(
          s,
          encodeMessage(refOf("paid"), s.recipient.address, 50_000_000n, home),
          50_700_000n,
        ),
      )
        .to.emit(proxy, "SalePaid")
        .withArgs(refOf("paid"), s.recipient.address, 50_000_000n, 700_000n);
      expect(await record(proxy, "paid", s.recipient.address, 50_000_000n)).to.deep.equal({
        status: 1n,
        amount: 50_700_000n,
        leftover: 700_000n,
      });
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
    });

    it("holds a short delivery", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("short");
      const proxy = await proxyAt(s, home);
      await expect(
        deliver(
          s,
          encodeMessage(refOf("short"), s.recipient.address, 50_000_000n, home),
          49_000_000n,
        ),
      )
        .to.emit(proxy, "SaleHeld")
        .withArgs(refOf("short"), s.recipient.address, 50_000_000n, 49_000_000n, reason("short"));
      expect(await record(proxy, "short", s.recipient.address, 50_000_000n)).to.deep.equal({
        status: 2n,
        amount: 49_000_000n,
        leftover: 0n,
      });
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(49_000_000n);
    });

    it("holds when the payout is refused", async () => {
      const s = await loadFixture(deploySystem);
      await s.usdc.setBlocked(s.recipient.address, true);
      const home = homeOf("blocked");
      const proxy = await proxyAt(s, home);
      await expect(
        deliver(
          s,
          encodeMessage(refOf("blocked"), s.recipient.address, 50_000_000n, home),
          50_500_000n,
        ),
      )
        .to.emit(proxy, "SaleHeld")
        .withArgs(
          refOf("blocked"),
          s.recipient.address,
          50_000_000n,
          50_500_000n,
          reason("payout"),
        );
      expect(await record(proxy, "blocked", s.recipient.address, 50_000_000n)).to.deep.equal({
        status: 2n,
        amount: 50_500_000n,
        leftover: 0n,
      });
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(50_500_000n);
    });

    it("holds bad terms without a record: zero recipient, zero committed, oversized amounts", async () => {
      const s = await loadFixture(deploySystem);
      const cases: [string, string, bigint, bigint][] = [
        ["t1", ethers.ZeroAddress, 5n, 5n],
        ["t2", s.recipient.address, 0n, 5n],
        ["t3", s.recipient.address, 2n ** 96n, 5n],
      ];
      for (const [id, r, c, a] of cases) {
        const home = homeOf(id);
        const proxy = await proxyAt(s, home);
        await expect(deliver(s, encodeMessage(refOf(id), r, c, home), a))
          .to.emit(proxy, "SaleHeld")
          .withArgs(refOf(id), r, c, a, reason("terms"));
        expect((await record(proxy, id, r, c)).status).to.equal(0n);
      }
      await s.factory.deploy(homeOf("t4"), CLAIMER);
      const proxy = await proxyAt(s, homeOf("t4"));
      const factory = await asFactory(s);
      await expect(
        proxy
          .connect(factory)
          .onDelivery(refOf("t4"), s.recipient.address, 1n, 2n ** 96n, FAR_DEADLINE),
      )
        .to.emit(proxy, "SaleHeld")
        .withArgs(refOf("t4"), s.recipient.address, 1n, 2n ** 96n, reason("terms"));
    });

    it("holds a zero deadline as bad terms without a record", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("t0");
      const proxy = await proxyAt(s, home);
      await expect(
        deliver(
          s,
          encodeMessage(refOf("t0"), s.recipient.address, 50_000_000n, home, 0n),
          50_000_000n,
        ),
      )
        .to.emit(proxy, "SaleHeld")
        .withArgs(refOf("t0"), s.recipient.address, 50_000_000n, 50_000_000n, reason("terms"));
      expect((await record(proxy, "t0", s.recipient.address, 50_000_000n)).status).to.equal(0n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(0n);
    });

    it("pays a delivery that lands at its deadline", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("on-time");
      const proxy = await proxyAt(s, home);
      const deadline = BigInt(await time.latest()) + 3600n;
      await time.setNextBlockTimestamp(deadline);
      await expect(
        deliver(
          s,
          encodeMessage(refOf("on-time"), s.recipient.address, 50_000_000n, home, deadline),
          50_000_000n,
        ),
      )
        .to.emit(proxy, "SalePaid")
        .withArgs(refOf("on-time"), s.recipient.address, 50_000_000n, 0n);
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(50_000_000n);
    });

    it("holds a delivery that lands after its deadline, and it goes home", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("late");
      const proxy = await proxyAt(s, home);
      const deadline = BigInt(await time.latest()) + 3600n;
      await time.setNextBlockTimestamp(deadline + 1n);
      await expect(
        deliver(
          s,
          encodeMessage(refOf("late"), s.recipient.address, 50_000_000n, home, deadline),
          50_500_000n,
        ),
      )
        .to.emit(proxy, "SaleHeld")
        .withArgs(refOf("late"), s.recipient.address, 50_000_000n, 50_500_000n, reason("expired"));
      expect(await record(proxy, "late", s.recipient.address, 50_000_000n)).to.deep.equal({
        status: 2n,
        amount: 50_500_000n,
        leftover: 0n,
      });
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(0n);
      await expect(proxy.returnHome()).to.emit(proxy, "ReturnedHome");
      expect((await s.vault.lastSwap()).amount).to.equal(50_500_000n);
      expect((await s.vault.lastSwap()).dstAddress).to.equal(home);
    });

    it("pays nothing for a replay of the same terms after the deadline", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("replay");
      const proxy = await proxyAt(s, home);
      const deadline = BigInt(await time.latest()) + 3600n;
      const msg = encodeMessage(refOf("replay"), s.recipient.address, 50_000_000n, home, deadline);
      await expect(deliver(s, msg, 10_000_000n)).to.emit(proxy, "SaleHeld");
      await time.increaseTo(deadline + 1n);
      await expect(deliver(s, msg, 50_000_000n))
        .to.emit(proxy, "SaleHeld")
        .withArgs(
          refOf("replay"),
          s.recipient.address,
          50_000_000n,
          50_000_000n,
          reason("expired"),
        );
      expect(await record(proxy, "replay", s.recipient.address, 50_000_000n)).to.deep.equal({
        status: 2n,
        amount: 60_000_000n,
        leftover: 0n,
      });
      expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(0n);
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(60_000_000n);
    });

    it("pays each sale on one proxy from its own amount only", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "a", 50_000_000n, 30_000_000n);
      const other = ethers.Wallet.createRandom().address;
      // 30 held from sale a must not fund sale b's 20 committed
      await expect(deliver(s, encodeMessage(refOf("b"), other, 20_000_000n, home), 10_000_000n))
        .to.emit(proxy, "SaleHeld")
        .withArgs(refOf("b"), other, 20_000_000n, 10_000_000n, reason("short"));
      expect(await s.usdc.balanceOf(other)).to.equal(0n);
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(40_000_000n);
    });

    it("pays a held sale when a full delivery of the same terms follows", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "late", 50_000_000n, 10_000_000n);
      const msg = encodeMessage(refOf("late"), s.recipient.address, 50_000_000n, home);
      await expect(deliver(s, msg, 50_000_000n)).to.emit(proxy, "SalePaid");
      expect(await record(proxy, "late", s.recipient.address, 50_000_000n)).to.deep.equal({
        status: 1n,
        amount: 60_000_000n,
        leftover: 0n,
      });
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(10_000_000n);
    });

    it("answers zeros for terms it never saw", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "seen", 50_000_000n, 50_000_000n);
      expect(await record(proxy, "seen", s.recipient.address, 50_000_001n)).to.deep.equal({
        status: 0n,
        amount: 0n,
        leftover: 0n,
      });
      await expect(
        s.implementation.delivery(refOf("seen"), s.recipient.address, 1n),
      ).to.be.revertedWithCustomError(s.implementation, "NotProxy");
    });

    it("resets the return backoff on every delivery", async () => {
      const { s, home, proxy } = await loadFixture(heldSale);
      await proxy.returnHome();
      await s.vault.refund(await s.usdc.getAddress(), await proxy.getAddress(), 40_000_000n);
      expect(await proxy.attempts()).to.equal(1);
      expect(await proxy.nextReturnAt()).to.be.greaterThan(BigInt(await time.latest()));
      await deliver(
        s,
        encodeMessage(refOf("next"), s.recipient.address, 5_000_000n, home),
        4_000_000n,
      );
      expect(await proxy.attempts()).to.equal(0);
      expect(await proxy.nextReturnAt()).to.equal(0n);
      await expect(proxy.returnHome()).to.emit(proxy, "ReturnedHome");
    });

    it("keeps the backoff and the release clock on a zero, bad-terms or fully paid out delivery", async () => {
      const { s, home, proxy } = await loadFixture(heldSale);
      await proxy.returnHome();
      const activity = await proxy.lastActivityAt();
      await time.increase(3600);
      await deliver(s, encodeMessage(refOf("zero"), s.recipient.address, 1n, home), 0n);
      await deliver(s, encodeMessage(refOf("junk"), ethers.ZeroAddress, 1n, home), 1_000_000n);
      // A third party's sale that pays itself back in full leaves nothing here
      await expect(
        deliver(s, encodeMessage(refOf("echo"), s.stranger.address, 2_000_000n, home), 2_000_000n),
      ).to.emit(proxy, "SalePaid");
      expect(await proxy.attempts()).to.equal(1);
      expect(await proxy.lastActivityAt()).to.equal(activity);
    });

    it("restarts the backoff and the release clock on a paid sale's leftover", async () => {
      const { s, home, proxy } = await loadFixture(heldSale);
      await proxy.returnHome();
      await time.increase(3600);
      await deliver(
        s,
        encodeMessage(refOf("left"), s.recipient.address, 2_000_000n, home),
        2_000_001n,
      );
      expect(await proxy.attempts()).to.equal(0);
      expect(await proxy.lastActivityAt()).to.equal(await time.latest());
    });
  });

  describe("returnHome", () => {
    it("anyone sends the balance home with fixed destination and cfParameters", async () => {
      const { s, home, proxy } = await loadFixture(heldSale);
      const address = await proxy.getAddress();
      const minPrice = minPriceX128(
        40_000_000n,
        TEST_NETWORK.priceFloorBps,
        TEST_NETWORK.feeAllowance,
      );
      await expect(proxy.connect(s.stranger).returnHome())
        .to.emit(proxy, "ReturnedHome")
        .withArgs(40_000_000n, minPrice, 1);
      const swap = await s.vault.lastSwap();
      expect(swap.dstChain).to.equal(6);
      expect(swap.dstAddress).to.equal(home);
      expect(swap.dstToken).to.equal(12);
      expect(swap.srcToken).to.equal(await s.usdc.getAddress());
      expect(swap.amount).to.equal(40_000_000n);
      expect(swap.sender).to.equal(address);
      expect(swap.cfParameters).to.equal(
        encodeCfParameters(TEST_NETWORK.retryBlocks, address, minPrice, TEST_NETWORK.broker),
      );
      expect(await s.usdc.allowance(address, await s.vault.getAddress())).to.equal(0n);
      expect(await s.usdc.balanceOf(address)).to.equal(0n);
    });

    it("refuses below the minimum", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "small", 5_000_000n, 5_000_000n - 1n);
      await expect(proxy.returnHome())
        .to.be.revertedWithCustomError(proxy, "BelowMinimum")
        .withArgs(5_000_000n - 1n, MIN);
    });

    it("backs off exponentially up to the 64x cap", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      const address = await proxy.getAddress();
      for (let attempt = 1; attempt <= 9; attempt++) {
        await proxy.returnHome();
        const last = BigInt(await time.latest());
        const shift = BigInt(Math.min(attempt - 1, 6));
        const due = last + (COOLDOWN << shift);
        expect(await proxy.nextReturnAt()).to.equal(due);
        expect(await proxy.attempts()).to.equal(attempt);
        // A killed return comes back to the proxy
        await s.vault.refund(await s.usdc.getAddress(), address, 40_000_000n);
        await expect(proxy.returnHome())
          .to.be.revertedWithCustomError(proxy, "ReturnNotDue")
          .withArgs(due);
        await time.increaseTo(due);
      }
    });

    it("returns a killed return again once its cooldown passes", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      await proxy.returnHome();
      const due = await proxy.nextReturnAt();
      await s.vault.refund(await s.usdc.getAddress(), await proxy.getAddress(), 40_000_000n);
      await expect(proxy.returnHome())
        .to.be.revertedWithCustomError(proxy, "ReturnNotDue")
        .withArgs(due);
      await time.increase(COOLDOWN);
      const minPrice = minPriceX128(
        40_000_000n,
        TEST_NETWORK.priceFloorBps,
        TEST_NETWORK.feeAllowance,
      );
      await expect(proxy.returnHome())
        .to.emit(proxy, "ReturnedHome")
        .withArgs(40_000_000n, minPrice, 2);
    });

    it("never leaves a chunk remainder below MIN_RETURN", async () => {
      const s = await loadFixture(deploySystem);
      const cases: [bigint, bigint][] = [
        [MAX, MAX],
        [MAX + 1n, MAX + 1n - MIN],
        [MAX + MIN - 1n, MAX - 1n],
        [MAX + MIN, MAX],
        [MAX + 3n * MIN, MAX],
      ];
      for (const [i, [balance, sent]] of cases.entries()) {
        const { proxy } = await sell(s, `chunk-${i}`, balance + 1n, balance);
        await proxy.returnHome();
        const rest = await s.usdc.balanceOf(await proxy.getAddress());
        expect((await s.vault.lastSwap()).amount, String(balance)).to.equal(sent);
        expect(rest === 0n || rest >= MIN, String(balance)).to.equal(true);
      }
    });

    it("sends a paid sale's leftover home", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "paidret", 50_000_000n, 75_000_000n);
      await proxy.returnHome();
      expect((await s.vault.lastSwap()).amount).to.equal(25_000_000n);
    });

    it("works on funds flushed with no sale booked", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("none");
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), true);
      await deliver(
        s,
        encodeMessage(refOf("none"), s.recipient.address, 30_000_000n, home),
        30_000_000n,
      );
      await s.usdc.setBlocked(await s.factory.predict(home, CLAIMER), false);
      await s.factory.flush(home, CLAIMER);
      const proxy = await proxyAt(s, home);
      await proxy.returnHome();
      expect((await s.vault.lastSwap()).amount).to.equal(30_000_000n);
    });

    it("does not count an attempt when the Vault reverts", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      await s.vault.setPaused(true);
      await expect(proxy.returnHome()).to.be.revertedWith("Vault: suspended");
      expect(await proxy.attempts()).to.equal(0);
      expect(await proxy.nextReturnAt()).to.equal(0);
      await s.vault.setPaused(false);
      await proxy.returnHome();
      expect(await proxy.attempts()).to.equal(1);
    });

    it("releases a killed return that comes back under MIN_RETURN, unless a top-up sends it home", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "erode", MIN + 300_000n, MIN + 300_000n - 1n);
      const address = await proxy.getAddress();
      await proxy.returnHome();
      // Chainflip refunds a killed swap less its refund fee
      const back = MIN + 300_000n - 1n - TEST_NETWORK.refundFee;
      await s.vault.refund(await s.usdc.getAddress(), address, back);
      await time.increase(COOLDOWN);
      await expect(proxy.returnHome()).to.be.revertedWithCustomError(proxy, "BelowMinimum");
      const due = (await proxy.lastActivityAt()) + RELEASE_DELAY;
      await expect(proxy.release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(due);
      const snap = await ethers.provider.send("evm_snapshot", []);
      await time.increaseTo(due);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(back);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(back);
      await ethers.provider.send("evm_revert", [snap]);
      await s.usdc.mint(address, MIN - back);
      await expect(proxy.returnHome()).to.emit(proxy, "ReturnedHome");
    });

    it("is refused once the factory is retired, release takes over", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      await s.factory.connect(s.guardian).retire();
      await expect(proxy.returnHome()).to.be.revertedWithCustomError(proxy, "FactoryRetired");
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(40_000_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(40_000_000n);
    });

    it("refuses calls on the implementation", async () => {
      const s = await loadFixture(deploySystem);
      const impl = s.implementation;
      await expect(impl.returnHome()).to.be.revertedWithCustomError(impl, "NotProxy");
      await expect(impl.release()).to.be.revertedWithCustomError(impl, "NotProxy");
      await expect(impl.home()).to.be.revertedWithCustomError(impl, "NotProxy");
      await expect(impl.claimer()).to.be.revertedWithCustomError(impl, "NotProxy");
      await expect(impl.state()).to.be.revertedWithCustomError(impl, "NotProxy");
    });
  });

  describe("release", () => {
    it("pays a balance below MIN_RETURN to the claimer once RELEASE_DELAY passes, from anyone", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "small", 5_000_000n, 4_000_000n);
      const due = (await proxy.lastActivityAt()) + RELEASE_DELAY;
      expect(await proxy.releaseAt()).to.equal(due);
      await time.increaseTo(due - 10n);
      await expect(proxy.release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(due);
      await time.setNextBlockTimestamp(due);
      await expect(proxy.connect(s.stranger).release())
        .to.emit(proxy, "Released")
        .withArgs(4_000_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(4_000_000n);
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(0n);
      expect(await s.usdc.balanceOf(s.stranger.address)).to.equal(0n);
    });

    it("waits STALE_DELAY, not RELEASE_DELAY, for a balance at or above MIN_RETURN", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      const activity = await proxy.lastActivityAt();
      expect(await proxy.releaseAt()).to.equal(activity + STALE_DELAY);
      await time.increaseTo(activity + RELEASE_DELAY);
      await expect(proxy.release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(activity + STALE_DELAY);
      await time.setNextBlockTimestamp(activity + STALE_DELAY);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(40_000_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(40_000_000n);
    });

    it("opens after RELEASE_ATTEMPTS returns sent, not one before, and keeps attempts", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      const address = await proxy.getAddress();
      for (let i = 1n; i <= RELEASE_ATTEMPTS; i++) {
        await returnWhenDue(proxy);
        await s.vault.refund(await s.usdc.getAddress(), address, 40_000_000n);
        if (i < RELEASE_ATTEMPTS) {
          await expect(proxy.release()).to.be.revertedWithCustomError(proxy, "ReleaseNotDue");
        }
      }
      expect(await proxy.releaseAt()).to.equal(0n);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(40_000_000n);
      expect(await proxy.attempts()).to.equal(RELEASE_ATTEMPTS);
    });

    it("out of attempts, a credit after the last return's refund window goes home, the next refund opens it", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      const address = await proxy.getAddress();
      for (let i = 1n; i <= RELEASE_ATTEMPTS; i++) {
        await returnWhenDue(proxy);
        await s.vault.refund(await s.usdc.getAddress(), address, 40_000_000n);
      }
      const window = (await proxy.lastReturnAt()) + RELEASE_DELAY;
      expect(await proxy.releaseAt()).to.equal(0n);
      await time.increaseTo(window + 1n);
      const activity = await proxy.lastActivityAt();
      expect(await proxy.releaseAt()).to.equal(activity + STALE_DELAY);
      await expect(proxy.release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(activity + STALE_DELAY);
      await returnWhenDue(proxy);
      expect(await s.usdc.balanceOf(address)).to.equal(0n);
      await s.vault.refund(await s.usdc.getAddress(), address, 40_000_000n);
      expect(await proxy.releaseAt()).to.equal(0n);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(40_000_000n);
    });

    it("out of attempts, dust sent to a draining proxy does not open release", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "dust", 9n * MAX + 1n, 9n * MAX);
      const address = await proxy.getAddress();
      for (let i = 1n; i <= RELEASE_ATTEMPTS; i++) await returnWhenDue(proxy);
      expect(await s.usdc.balanceOf(address)).to.be.greaterThan(MIN);
      await s.vault.refund(await s.usdc.getAddress(), address, MIN - 1n);
      expect(await proxy.releaseAt()).to.not.equal(0n);
      await expect(proxy.release()).to.be.revertedWithCustomError(proxy, "ReleaseNotDue");
    });

    it("stays shut while chunks that left drain a large balance, and opens once one comes back", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "drain", 9n * MAX + 1n, 9n * MAX);
      const address = await proxy.getAddress();
      while ((await s.usdc.balanceOf(address)) >= MIN) {
        await returnWhenDue(proxy);
        if ((await s.usdc.balanceOf(address)) > 0n) {
          await expect(proxy.release()).to.be.revertedWithCustomError(proxy, "ReleaseNotDue");
        }
      }
      expect(await proxy.attempts()).to.be.greaterThan(RELEASE_ATTEMPTS);
      expect(await s.usdc.balanceOf(address)).to.equal(0n);
      const back = MAX - TEST_NETWORK.refundFee;
      await s.vault.refund(await s.usdc.getAddress(), address, back);
      expect(await proxy.releaseAt()).to.equal(0n);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(back);
    });

    it("RELEASE_ATTEMPTS is the first return that waits the capped backoff", async () => {
      const { s, proxy } = await loadFixture(heldSale);
      const gaps: bigint[] = [];
      for (let i = 1n; i <= RELEASE_ATTEMPTS + 1n; i++) {
        await returnWhenDue(proxy);
        await s.vault.refund(await s.usdc.getAddress(), await proxy.getAddress(), 40_000_000n);
        gaps.push((await proxy.nextReturnAt()) - (await proxy.lastReturnAt()));
      }
      expect(gaps[Number(RELEASE_ATTEMPTS) - 2]).to.equal(COOLDOWN << (RELEASE_ATTEMPTS - 2n));
      expect(gaps[Number(RELEASE_ATTEMPTS) - 1]).to.equal(COOLDOWN << (RELEASE_ATTEMPTS - 1n));
      expect(gaps[Number(RELEASE_ATTEMPTS)]).to.equal(gaps[Number(RELEASE_ATTEMPTS) - 1]);
    });

    it("opens at once on a retired factory for any balance", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "retired", 50_000_000n, 50_400_000n);
      await expect(proxy.release()).to.be.revertedWithCustomError(proxy, "ReleaseNotDue");
      await s.factory.connect(s.guardian).retire();
      expect(await proxy.releaseAt()).to.equal(0n);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(400_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(400_000n);
    });

    it("takes a paid sale's leftover too, it is the seller's", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "leftover", 50_000_000n, 50_400_000n);
      await time.increase(RELEASE_DELAY);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(400_000n);
    });

    it("refuses an empty proxy", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "empty", 5_000_000n, 5_000_000n);
      await time.increase(STALE_DELAY);
      await expect(proxy.release()).to.be.revertedWithCustomError(proxy, "NothingToRelease");
    });

    it("reverts whole when USDC refuses the claimer, the balance stays", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "blocked-claimer", 5_000_000n, 4_000_000n);
      await time.increase(RELEASE_DELAY);
      await s.usdc.setBlocked(CLAIMER, true);
      await expect(proxy.release()).to.be.revertedWith("USDC: recipient blocked");
      expect(await s.usdc.balanceOf(await proxy.getAddress())).to.equal(4_000_000n);
      await s.usdc.setBlocked(CLAIMER, false);
      await expect(proxy.release()).to.emit(proxy, "Released");
    });

    it("releases a refund that lands after a release, and only to the claimer", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "again", 5_000_000n, 4_000_000n);
      await time.increase(RELEASE_DELAY);
      await proxy.release();
      await s.usdc.mint(await proxy.getAddress(), 2_000_000n);
      await expect(proxy.connect(s.stranger).release())
        .to.emit(proxy, "Released")
        .withArgs(2_000_000n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(6_000_000n);
    });

    it("never opens by time on a never-booked balance of MIN_RETURN or more, it goes home first", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("unbooked");
      await s.factory.deploy(home, CLAIMER);
      const proxy = await proxyAt(s, home);
      await s.usdc.mint(await proxy.getAddress(), MIN);
      expect(await proxy.lastActivityAt()).to.equal(0n);
      expect(await proxy.releaseAt()).to.equal(ethers.MaxUint256);
      await time.increase(STALE_DELAY);
      await expect(proxy.release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(ethers.MaxUint256);
      const st = await proxy.state();
      expect([st[6], st[7]]).to.deep.equal([ethers.MaxUint256, 0n]);
      await expect(proxy.returnHome()).to.emit(proxy, "ReturnedHome");
    });

    it("keeps a flushed sale on a never-booked proxy for returnHome", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("flushed");
      const proxy = await proxyAt(s, home);
      const address = await proxy.getAddress();
      await s.usdc.setBlocked(address, true);
      await deliver(s, encodeMessage(refOf("flushed"), s.recipient.address, MIN, home), MIN);
      await s.usdc.setBlocked(address, false);
      await s.factory.flush(home, CLAIMER);
      expect(await s.usdc.balanceOf(address)).to.equal(MIN);
      await expect(proxy.connect(s.stranger).release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(ethers.MaxUint256);
    });

    it("pays a never-booked balance below MIN_RETURN at once, it can never go home", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("unbooked-small");
      await s.factory.deploy(home, CLAIMER);
      const proxy = await proxyAt(s, home);
      await s.usdc.mint(await proxy.getAddress(), MIN - 1n);
      expect(await proxy.releaseAt()).to.equal(RELEASE_DELAY);
      await expect(proxy.connect(s.stranger).release())
        .to.emit(proxy, "Released")
        .withArgs(MIN - 1n);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(MIN - 1n);
    });

    it("starts the stale clock on a never-booked proxy at its first return", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("unbooked-refund");
      await s.factory.deploy(home, CLAIMER);
      const proxy = await proxyAt(s, home);
      const address = await proxy.getAddress();
      await s.usdc.mint(address, MIN);
      await proxy.returnHome();
      await s.vault.refund(await s.usdc.getAddress(), address, MIN);
      const due = (await proxy.lastActivityAt()) + STALE_DELAY;
      expect(await proxy.releaseAt()).to.equal(due);
      await time.increaseTo(due - 10n);
      await expect(proxy.release())
        .to.be.revertedWithCustomError(proxy, "ReleaseNotDue")
        .withArgs(due);
      await time.setNextBlockTimestamp(due);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(MIN);
      expect(await s.usdc.balanceOf(CLAIMER)).to.equal(MIN);
    });

    it("opens a never-booked balance of MIN_RETURN or more on a retired factory", async () => {
      const s = await loadFixture(deploySystem);
      const home = homeOf("unbooked-retired");
      await s.factory.deploy(home, CLAIMER);
      const proxy = await proxyAt(s, home);
      await s.usdc.mint(await proxy.getAddress(), MIN);
      await s.factory.connect(s.guardian).retire();
      expect(await proxy.releaseAt()).to.equal(0n);
      await expect(proxy.release()).to.emit(proxy, "Released").withArgs(MIN);
    });

    it("restarts its clock on a valid delivery only, a junk delivery cannot delay it", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "clock", 5_000_000n, 4_000_000n);
      const first = await proxy.releaseAt();
      await time.increase(RELEASE_DELAY - 100n);
      await deliver(s, encodeMessage(refOf("junk"), ethers.ZeroAddress, 1n, home), 1_000_000n);
      expect(await proxy.releaseAt()).to.equal(first);
      await deliver(s, encodeMessage(refOf("clock2"), s.recipient.address, 9n, home), 1n);
      expect(await proxy.releaseAt()).to.equal((await proxy.lastActivityAt()) + RELEASE_DELAY);
      expect(await proxy.releaseAt()).to.be.greaterThan(first);
    });
  });

  describe("skimForeign", () => {
    it("refuses USDC and moves another token to the factory", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "foreign", 5n, 5n);
      await expect(proxy.skimForeign(await s.usdc.getAddress())).to.be.revertedWithCustomError(
        proxy,
        "CannotSkimUSDC",
      );
      const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await other.mint(await proxy.getAddress(), 8n);
      await expect(proxy.skimForeign(await other.getAddress()))
        .to.emit(proxy, "ForeignSkimmed")
        .withArgs(await other.getAddress(), 8n);
      expect(await other.balanceOf(await s.factory.getAddress())).to.equal(8n);
    });
  });

  describe("skimNative", () => {
    it("sends ETH forced into a proxy straight to the treasury, from anyone", async () => {
      const s = await loadFixture(deploySystem);
      const { proxy } = await sell(s, "eth", 5n, 5n);
      await setBalance(await proxy.getAddress(), ethers.parseEther("1"));
      const before = await ethers.provider.getBalance(s.treasury.address);
      await expect(proxy.connect(s.stranger).skimNative())
        .to.emit(proxy, "ForeignSkimmed")
        .withArgs(ethers.ZeroAddress, ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(s.treasury.address)).to.equal(
        before + ethers.parseEther("1"),
      );
      expect(await ethers.provider.getBalance(await proxy.getAddress())).to.equal(0n);
    });

    it("reverts when the treasury refuses ETH", async () => {
      const [, , , , guardian] = await ethers.getSigners();
      const { usdc, vault } = await deployMocks();
      const net = {
        ...TEST_NETWORK,
        vault: await vault.getAddress(),
        usdc: await usdc.getAddress(),
      };
      const factory = await (
        await ethers.getContractFactory("SaleVaultProxyFactory")
      ).deploy(factoryConfig(net, await usdc.getAddress(), guardian.address));
      await factory.deploy(homeOf("eth"), CLAIMER);
      const proxy = await ethers.getContractAt(
        "SaleVaultProxy",
        await factory.predict(homeOf("eth"), CLAIMER),
      );
      await setBalance(await proxy.getAddress(), 1n);
      await expect(proxy.skimNative()).to.be.revertedWithCustomError(proxy, "TransferFailed");
    });
  });

  describe("state", () => {
    it("returns the eight words in order", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "state", 50_000_000n, 50_400_000n);
      await s.usdc.mint(await proxy.getAddress(), 100_000n);
      const st = await proxy.state();
      const due = (await proxy.lastActivityAt()) + RELEASE_DELAY;
      expect(st.length).to.equal(8);
      expect(st[0]).to.equal(home);
      expect(st[1]).to.equal(CLAIMER);
      expect(st[2]).to.equal(500_000n);
      expect(st[3]).to.equal(0n);
      expect(st[4]).to.equal(0n);
      expect(st[5]).to.equal(0n);
      expect(st[6]).to.equal(due);
      expect(st[7]).to.equal(0n);
      await time.increaseTo(due);
      expect((await proxy.state())[7]).to.equal(500_000n);
    });

    it("reads the claimer the factory bound into the address", async () => {
      const s = await loadFixture(deploySystem);
      const { home, proxy } = await sell(s, "args", 5n, 5n);
      expect(await proxy.home()).to.equal(home);
      expect(await proxy.claimer()).to.equal(CLAIMER);
    });
  });

  describe("reentrancy", () => {
    async function reentrant() {
      const [, treasury, recipient] = await ethers.getSigners();
      const { vault } = await deployMocks();
      const token = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      await token.mint(await vault.getAddress(), 1_000_000_000_000n);
      const net = {
        ...TEST_NETWORK,
        vault: await vault.getAddress(),
        usdc: await token.getAddress(),
      };
      const factory = await (
        await ethers.getContractFactory("SaleVaultProxyFactory")
      ).deploy(factoryConfig(net, treasury.address, treasury.address));
      return { token, vault, factory, recipient };
    }

    it("refuses a re-entered returnHome", async () => {
      const { token, vault, factory, recipient } = await loadFixture(reentrant);
      const home = homeOf("re1");
      await vault.deliver(
        await factory.getAddress(),
        6,
        "0x00",
        encodeMessage(refOf("re1"), recipient.address, 50_000_000n, home),
        await token.getAddress(),
        40_000_000n,
      );
      const proxy = await ethers.getContractAt(
        "SaleVaultProxy",
        await factory.predict(home, CLAIMER),
      );
      await token.arm(await proxy.getAddress(), proxy.interface.encodeFunctionData("returnHome"));
      await expect(proxy.returnHome()).to.be.revertedWithCustomError(
        proxy,
        "ReentrancyGuardReentrantCall",
      );
    });

    it("refuses a re-entered release", async () => {
      const { token, vault, factory, recipient } = await loadFixture(reentrant);
      const home = homeOf("re2");
      await vault.deliver(
        await factory.getAddress(),
        6,
        "0x00",
        encodeMessage(refOf("re2"), recipient.address, 50_000_000n, home),
        await token.getAddress(),
        4_000_000n,
      );
      const proxy = await ethers.getContractAt(
        "SaleVaultProxy",
        await factory.predict(home, CLAIMER),
      );
      await time.increase(RELEASE_DELAY);
      await token.arm(await proxy.getAddress(), proxy.interface.encodeFunctionData("release"));
      await expect(proxy.release()).to.be.revertedWithCustomError(
        proxy,
        "ReentrancyGuardReentrantCall",
      );
    });
  });
});
