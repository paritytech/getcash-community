import { expect } from "chai";
import { ethers } from "hardhat";
import { HOME_CHAIN, HOME_TOKEN } from "../config/chainflip";

// The one message layout, shared with the SPA encoder (packages/offramp message.ts). If this vector
// changes, the app encoder must change with it. abi.encode of four static words is exactly 128 bytes.
// abi.encodePacked would be 116 and would not decode.
const coder = ethers.AbiCoder.defaultAbiCoder();

describe("sale message", () => {
  const ref = "0x" + "11".repeat(32);
  const recipient = "0x1111111111111111111111111111111111111111";
  const amount = 123_456_789n;
  const home = "0x" + "22".repeat(32);

  it("encodes to exactly 128 bytes", () => {
    const message = coder.encode(
      ["bytes32", "address", "uint256", "bytes32"],
      [ref, recipient, amount, home],
    );
    expect(ethers.dataLength(message)).to.equal(128);
  });

  it("the contract decodes the vector to the same fields", async () => {
    const [, operator, admin, payee] = await ethers.getSigners();
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
    await usdc.mint(await vault.getAddress(), 1_000_000_000n);

    const r = ethers.keccak256(ethers.toUtf8Bytes("vector"));
    const h = "0x" + "ab".repeat(32);
    const message = coder.encode(
      ["bytes32", "address", "uint256", "bytes32"],
      [r, payee.address, amount, h],
    );
    await expect(
      vault.deliver(await sale.getAddress(), 6, "0x00", message, await usdc.getAddress(), amount),
    )
      .to.emit(sale, "SalePaid")
      .withArgs(r, payee.address, amount, 0n);
    const stored = await sale.sales(r);
    expect(stored.recipient).to.equal(payee.address);
    expect(stored.amount).to.equal(amount);
    expect(stored.home).to.equal(h);
  });
});
