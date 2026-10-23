import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import fc from "fast-check";
import { HOME_CHAIN, HOME_TOKEN } from "../config/chainflip";

const coder = ethers.AbiCoder.defaultAbiCoder();
const CF = "0x"; // empty cfParameters in tests
const SRC_CHAIN = 6;
const SRC_ADDR = "0x1234";

// A sale message, exactly as the SPA will ABI-encode it (128 bytes).
function encodeMessage(ref: string, recipient: string, amount: bigint, home: string): string {
  return coder.encode(["bytes32", "address", "uint256", "bytes32"], [ref, recipient, amount, home]);
}

function refOf(id: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(id));
}

function homeOf(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(seed)); // a 32-byte stand-in for an Asset Hub account
}

async function deploy() {
  const [deployer, operator, admin, recipient, stranger] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const vault = await (await ethers.getContractFactory("MockChainflipVault")).deploy();
  const sale = await (
    await ethers.getContractFactory("SaleVault")
  ).deploy(
    await vault.getAddress(),
    await usdc.getAddress(),
    HOME_CHAIN,
    HOME_TOKEN,
    operator.address,
    admin.address,
  );
  // Fund the vault so it can deliver USDC into the SaleVault.
  await usdc.mint(await vault.getAddress(), 1_000_000_000_000n);
  return { sale, usdc, vault, deployer, operator, admin, recipient, stranger };
}

// Deliver a message through the mock vault, mirroring Chainflip's transfer-then-call order. Returns
// the transaction so the `.emit` matcher can await it, and `await deliver(...)` also works to just run it.
async function deliver(
  f: Awaited<ReturnType<typeof deploy>>,
  message: string,
  amount: bigint,
  token?: string,
) {
  const t = token ?? (await f.usdc.getAddress());
  return f.vault.deliver(await f.sale.getAddress(), SRC_CHAIN, SRC_ADDR, message, t, amount);
}

describe("SaleVault", () => {
  describe("constructor", () => {
    it("stores the immutables and roles", async () => {
      const f = await loadFixture(deploy);
      expect(await f.sale.VAULT()).to.equal(await f.vault.getAddress());
      expect(await f.sale.USDC()).to.equal(await f.usdc.getAddress());
      expect(await f.sale.HOME_CHAIN()).to.equal(HOME_CHAIN);
      expect(await f.sale.HOME_TOKEN()).to.equal(HOME_TOKEN);
      expect(await f.sale.operator()).to.equal(f.operator.address);
      expect(await f.sale.admin()).to.equal(f.admin.address);
    });

    it("rejects a zero address", async () => {
      const [, operator, admin] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const Sale = await ethers.getContractFactory("SaleVault");
      await expect(
        Sale.deploy(
          ethers.ZeroAddress,
          await usdc.getAddress(),
          HOME_CHAIN,
          HOME_TOKEN,
          operator.address,
          admin.address,
        ),
      ).to.be.revertedWithCustomError(Sale, "ZeroAddress");
    });
  });

  describe("cfReceive", () => {
    it("reverts for a non-vault caller", async () => {
      const f = await loadFixture(deploy);
      const msg = encodeMessage(refOf("a"), f.recipient.address, 100n, homeOf("a"));
      await expect(
        f.sale
          .connect(f.stranger)
          .cfReceive(SRC_CHAIN, SRC_ADDR, msg, await f.usdc.getAddress(), 100n),
      ).to.be.revertedWithCustomError(f.sale, "NotVault");
    });

    it("pays exactly C and keeps the leftover as dust", async () => {
      const f = await loadFixture(deploy);
      const ref = refOf("pay");
      const msg = encodeMessage(ref, f.recipient.address, 100_000_000n, homeOf("pay"));
      await expect(deliver(f, msg, 100_500_000n))
        .to.emit(f.sale, "SalePaid")
        .withArgs(ref, f.recipient.address, 100_000_000n, 500_000n);
      expect(await f.usdc.balanceOf(f.recipient.address)).to.equal(100_000_000n);
      expect(await f.sale.dust()).to.equal(500_000n);
      const s = await f.sale.sales(ref);
      expect(s.status).to.equal(1); // Paid
    });

    it("holds the full amount when the payout is blocked", async () => {
      const f = await loadFixture(deploy);
      await f.usdc.setBlocked(f.recipient.address, true);
      const ref = refOf("blocked");
      const msg = encodeMessage(ref, f.recipient.address, 100_000_000n, homeOf("blocked"));
      await expect(deliver(f, msg, 100_500_000n))
        .to.emit(f.sale, "SaleHeld")
        .withArgs(ref, 100_500_000n);
      expect(await f.sale.dust()).to.equal(0n);
      expect(await f.sale.heldTotal()).to.equal(100_500_000n);
      const s = await f.sale.sales(ref);
      expect(s.status).to.equal(2); // Held
      expect(s.held).to.equal(100_500_000n);
    });

    it("holds the whole delivery when underfilled (amount < C)", async () => {
      const f = await loadFixture(deploy);
      const ref = refOf("under");
      const msg = encodeMessage(ref, f.recipient.address, 100_000_000n, homeOf("under"));
      await expect(deliver(f, msg, 99_000_000n))
        .to.emit(f.sale, "SaleHeld")
        .withArgs(ref, 99_000_000n);
      expect(await f.sale.heldTotal()).to.equal(99_000_000n);
    });

    it("flags a wrong token without counting it in a USDC bucket", async () => {
      const f = await loadFixture(deploy);
      const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await other.mint(await f.vault.getAddress(), 1_000_000n);
      const msg = encodeMessage(refOf("wt"), f.recipient.address, 100n, homeOf("wt"));
      await expect(deliver(f, msg, 100n, await other.getAddress()))
        .to.emit(f.sale, "Unknown")
        .withArgs(100n, ethers.encodeBytes32String("token"));
      // A non-USDC delivery is not counted in stuck (stuck is USDC-denominated).
      expect(await f.sale.stuck()).to.equal(0n);
    });

    it("routes a bad-length message to stuck", async () => {
      const f = await loadFixture(deploy);
      await expect(deliver(f, "0xdeadbeef", 100n))
        .to.emit(f.sale, "Unknown")
        .withArgs(100n, ethers.encodeBytes32String("message"));
      expect(await f.sale.stuck()).to.equal(100n);
    });

    it("routes a repeated ref to stuck", async () => {
      const f = await loadFixture(deploy);
      const ref = refOf("dup");
      const msg = encodeMessage(ref, f.recipient.address, 100_000_000n, homeOf("dup"));
      await deliver(f, msg, 100_000_000n);
      await expect(deliver(f, msg, 100_000_000n))
        .to.emit(f.sale, "Unknown")
        .withArgs(100_000_000n, ethers.encodeBytes32String("ref"));
      expect(await f.sale.stuck()).to.equal(100_000_000n);
    });

    it("routes an out-of-range committed amount to stuck", async () => {
      const f = await loadFixture(deploy);
      const huge = 2n ** 128n; // > type(uint128).max
      const msg = encodeMessage(refOf("range"), f.recipient.address, huge, homeOf("range"));
      await expect(deliver(f, msg, 100n))
        .to.emit(f.sale, "Unknown")
        .withArgs(100n, ethers.encodeBytes32String("range"));
      expect(await f.sale.stuck()).to.equal(100n);
    });

    it("masks a dirty address word without reverting (the reason for the manual decode)", async () => {
      const f = await loadFixture(deploy);
      const ref = "0x" + "aa".repeat(32);
      // 12 bytes of dirt in the high part of the address word, a real address in the low 20 bytes.
      const addrWord = "0x" + "de".repeat(12) + f.recipient.address.slice(2).toLowerCase();
      const amtWord = ethers.toBeHex(100_000_000n, 32);
      const homeWord = "0x" + "bb".repeat(32);
      const message = ethers.concat([ref, addrWord, amtWord, homeWord]);
      await expect(deliver(f, message, 100_500_000n))
        .to.emit(f.sale, "SalePaid")
        .withArgs(ref, f.recipient.address, 100_000_000n, 500_000n);
      expect(await f.usdc.balanceOf(f.recipient.address)).to.equal(100_000_000n);
    });

    it("unclaimed is the balance minus every counted bucket", async () => {
      const f = await loadFixture(deploy);
      await deliver(
        f,
        encodeMessage(refOf("uc"), f.recipient.address, 100_000_000n, homeOf("uc")),
        100_500_000n,
      );
      await deliver(f, "0xdeadbeef", 1_000_000n); // adds to stuck
      // The contract holds dust + stuck, so nothing is unattributed.
      expect(await f.sale.unclaimed()).to.equal(0n);
    });
  });

  describe("returns", () => {
    it("returnHeld swaps a held amount home and marks it Returned, operator only", async () => {
      const f = await loadFixture(deploy);
      await f.usdc.setBlocked(f.recipient.address, true);
      const ref = refOf("rh");
      const home = homeOf("rh");
      await deliver(f, encodeMessage(ref, f.recipient.address, 100_000_000n, home), 100_500_000n);
      // A stranger cannot supply their own cfParameters to redirect the kill-refund to themselves.
      await expect(f.sale.connect(f.stranger).returnHeld(ref, CF)).to.be.revertedWithCustomError(
        f.sale,
        "NotOperator",
      );
      await expect(f.sale.connect(f.operator).returnHeld(ref, CF)).to.emit(f.sale, "Returned");
      expect(await f.sale.heldTotal()).to.equal(0n);
      expect((await f.sale.sales(ref)).status).to.equal(3); // Returned
      const swap = await f.vault.lastSwap();
      expect(swap.amount).to.equal(100_500_000n);
      expect(swap.dstChain).to.equal(HOME_CHAIN);
      expect(swap.dstToken).to.equal(HOME_TOKEN);
      expect(swap.dstAddress).to.equal(home);
    });

    it("returnRefund sends home the free USDC a refund arrived as, operator only, at most once", async () => {
      const f = await loadFixture(deploy);
      const ref = refOf("rr");
      await deliver(
        f,
        encodeMessage(ref, f.recipient.address, 100_000_000n, homeOf("rr")),
        100_500_000n,
      );
      const dustBefore = await f.sale.dust();
      // Meld sends the paid amount back: it lands as free (unclaimed) USDC on the vault, not as dust.
      await f.usdc.mint(await f.sale.getAddress(), 100_000_000n);
      await expect(
        f.sale.connect(f.stranger).returnRefund(ref, 100_000_000n, CF),
      ).to.be.revertedWithCustomError(f.sale, "NotOperator");
      await expect(f.sale.connect(f.operator).returnRefund(ref, 100_000_000n, CF)).to.emit(
        f.sale,
        "Returned",
      );
      // The refund came from the free balance, so the operator's dust float is untouched.
      expect(await f.sale.dust()).to.equal(dustBefore);
      await expect(
        f.sale.connect(f.operator).returnRefund(ref, 1n, CF),
      ).to.be.revertedWithCustomError(f.sale, "NotPaid");
    });

    it("returnRefund refuses more than dust or more than C", async () => {
      const f = await loadFixture(deploy);
      const ref = refOf("rr3");
      await deliver(
        f,
        encodeMessage(ref, f.recipient.address, 100_000_000n, homeOf("rr3")),
        100_500_000n,
      );
      await expect(
        f.sale.connect(f.operator).returnRefund(ref, 200_000_000n, CF),
      ).to.be.revertedWithCustomError(f.sale, "BadAmount");
      await expect(
        f.sale.connect(f.operator).returnRefund(ref, 100_000_000n, CF),
      ).to.be.revertedWithCustomError(f.sale, "InsufficientDust");
    });
  });

  describe("operator funds", () => {
    it("withdrawDust moves dust to the operator, bounded", async () => {
      const f = await loadFixture(deploy);
      await deliver(
        f,
        encodeMessage(refOf("wd"), f.recipient.address, 100_000_000n, homeOf("wd")),
        100_500_000n,
      );
      await expect(f.sale.connect(f.operator).withdrawDust(600_000n)).to.be.revertedWithCustomError(
        f.sale,
        "BadAmount",
      );
      await f.sale.connect(f.operator).withdrawDust(500_000n);
      expect(await f.usdc.balanceOf(f.operator.address)).to.equal(500_000n);
      expect(await f.sale.dust()).to.equal(0n);
    });

    it("resolveUnknown sends stuck funds home, bounded", async () => {
      const f = await loadFixture(deploy);
      await deliver(f, "0xdeadbeef", 1_000_000n);
      await expect(
        f.sale.connect(f.operator).resolveUnknown(homeOf("u"), 2_000_000n, CF),
      ).to.be.revertedWithCustomError(f.sale, "BadAmount");
      await f.sale.connect(f.operator).resolveUnknown(homeOf("u"), 1_000_000n, CF);
      expect(await f.sale.stuck()).to.equal(0n);
    });

    it("rescueForeign moves a non-USDC token out and refuses USDC", async () => {
      const f = await loadFixture(deploy);
      const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await other.mint(await f.sale.getAddress(), 5_000_000n);
      await expect(
        f.sale.connect(f.operator).rescueForeign(await f.usdc.getAddress(), f.operator.address, 1n),
      ).to.be.revertedWithCustomError(f.sale, "CannotRescueUSDC");
      await f.sale
        .connect(f.operator)
        .rescueForeign(await other.getAddress(), f.stranger.address, 5_000_000n);
      expect(await other.balanceOf(f.stranger.address)).to.equal(5_000_000n);
    });

    it("rescueNative moves trapped ETH out", async () => {
      const f = await loadFixture(deploy);
      // Deliver a normal sale but with native value attached, which the payable callback traps.
      const msg = encodeMessage(refOf("nat"), f.recipient.address, 100_000_000n, homeOf("nat"));
      await f.vault.deliver(
        await f.sale.getAddress(),
        SRC_CHAIN,
        SRC_ADDR,
        msg,
        await f.usdc.getAddress(),
        100_000_000n,
        { value: ethers.parseEther("1") },
      );
      expect(await ethers.provider.getBalance(await f.sale.getAddress())).to.equal(
        ethers.parseEther("1"),
      );
      await f.sale.connect(f.operator).rescueNative(f.stranger.address, ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(await f.sale.getAddress())).to.equal(0n);
    });

    it("rescueUnclaimed recovers directly-donated USDC, bounded by unclaimed", async () => {
      const f = await loadFixture(deploy);
      // A real sale leaves dust, then someone donates USDC directly on top of it.
      await deliver(
        f,
        encodeMessage(refOf("uq"), f.recipient.address, 100_000_000n, homeOf("uq")),
        100_500_000n,
      );
      await f.usdc.mint(await f.sale.getAddress(), 7_000_000n); // a direct donation
      expect(await f.sale.unclaimed()).to.equal(7_000_000n);
      await expect(
        f.sale.connect(f.operator).rescueUnclaimed(f.stranger.address, 8_000_000n),
      ).to.be.revertedWithCustomError(f.sale, "BadAmount");
      await f.sale.connect(f.operator).rescueUnclaimed(f.stranger.address, 7_000_000n);
      expect(await f.usdc.balanceOf(f.stranger.address)).to.equal(7_000_000n);
      expect(await f.sale.unclaimed()).to.equal(0n);
      expect(await f.sale.dust()).to.equal(500_000n); // dust untouched
    });
  });

  describe("roles", () => {
    it("admin rotates operator, admin cannot move funds, two-step admin handover", async () => {
      const f = await loadFixture(deploy);
      await expect(
        f.sale.connect(f.stranger).setOperator(f.stranger.address),
      ).to.be.revertedWithCustomError(f.sale, "NotAdmin");
      await f.sale.connect(f.admin).setOperator(f.stranger.address);
      expect(await f.sale.operator()).to.equal(f.stranger.address);
      // Admin has no fund-moving function: withdrawDust is operator-gated.
      await expect(f.sale.connect(f.admin).withdrawDust(1n)).to.be.revertedWithCustomError(
        f.sale,
        "NotOperator",
      );
      // Two-step admin.
      await f.sale.connect(f.admin).transferAdmin(f.deployer.address);
      await expect(f.sale.connect(f.stranger).acceptAdmin()).to.be.revertedWithCustomError(
        f.sale,
        "NotPending",
      );
      await f.sale.connect(f.deployer).acceptAdmin();
      expect(await f.sale.admin()).to.equal(f.deployer.address);
    });
  });

  describe("invariant (property)", () => {
    it("dust + heldTotal + stuck <= balance after random deliveries and returns", async () => {
      const f = await loadFixture(deploy);
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              kind: fc.constantFrom("pay", "under", "blocked", "bad"),
              id: fc.string({ minLength: 1, maxLength: 8 }),
              c: fc.bigInt({ min: 1_000_000n, max: 200_000_000n }),
              over: fc.bigInt({ min: 0n, max: 5_000_000n }),
            }),
            { minLength: 1, maxLength: 12 },
          ),
          async (ops) => {
            const seen = new Set<string>();
            for (const op of ops) {
              if (seen.has(op.id)) continue;
              seen.add(op.id);
              const ref = refOf("inv:" + op.id);
              const home = homeOf("inv:" + op.id);
              if (op.kind === "bad") {
                await deliver(f, "0xabcdef", op.c);
                continue;
              }
              if (op.kind === "blocked") {
                await f.usdc.setBlocked(f.recipient.address, true);
                await deliver(
                  f,
                  encodeMessage(ref, f.recipient.address, op.c, home),
                  op.c + op.over,
                );
                await f.usdc.setBlocked(f.recipient.address, false);
                continue;
              }
              const amount = op.kind === "under" ? op.c / 2n : op.c + op.over;
              await deliver(f, encodeMessage(ref, f.recipient.address, op.c, home), amount);
            }
            const bal = await f.usdc.balanceOf(await f.sale.getAddress());
            const sum = (await f.sale.dust()) + (await f.sale.heldTotal()) + (await f.sale.stuck());
            return sum <= bal;
          },
        ),
        { numRuns: 25 },
      );
    });
  });
});
