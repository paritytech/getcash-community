import { expect } from "chai";
import { ethers } from "hardhat";
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { ARBITRUM_ONE, HOME_CHAIN, HOME_TOKEN } from "../config/chainflip";

// Runs only against a live Arbitrum One fork (set ARBITRUM_FORK=1), with a USDC-rich account to
// source real Circle USDC from (ARBITRUM_USDC_WHALE). Proves the exact-pay path works with the real
// token, including its 6 decimals and transfer behaviour, by mimicking Chainflip's delivery:
// transfer USDC into the vault, then call cfReceive impersonating the real Chainflip Vault.
const FORK = !!process.env.ARBITRUM_FORK;
const WHALE = process.env.ARBITRUM_USDC_WHALE;
const coder = ethers.AbiCoder.defaultAbiCoder();

(FORK ? describe : describe.skip)("SaleVault (Arbitrum One fork)", () => {
  it("pays exactly C in real USDC and keeps the leftover as dust", async () => {
    if (!WHALE)
      throw new Error("set ARBITRUM_USDC_WHALE to a USDC-rich Arbitrum account for the fork test");

    const [, operator, admin, recipient] = await ethers.getSigners();
    const sale = await (
      await ethers.getContractFactory("SaleVault")
    ).deploy(
      ARBITRUM_ONE.chainflipVault,
      ARBITRUM_ONE.usdc,
      HOME_CHAIN,
      HOME_TOKEN,
      operator.address,
      admin.address,
    );
    const saleAddr = await sale.getAddress();

    const usdc = await ethers.getContractAt("IERC20", ARBITRUM_ONE.usdc);
    const amount = 100_500_000n; // 100.5 USDC
    const committed = 100_000_000n; // 100 USDC

    // Source real USDC from the whale into the SaleVault, mirroring Chainflip's transfer step.
    await impersonateAccount(WHALE);
    await setBalance(WHALE, ethers.parseEther("1"));
    const whale = await ethers.getSigner(WHALE);
    await usdc.connect(whale).transfer(saleAddr, amount);

    // Impersonate the real Chainflip Vault and call cfReceive, the callback step.
    await impersonateAccount(ARBITRUM_ONE.chainflipVault);
    await setBalance(ARBITRUM_ONE.chainflipVault, ethers.parseEther("1"));
    const vault = await ethers.getSigner(ARBITRUM_ONE.chainflipVault);
    const ref = ethers.keccak256(ethers.toUtf8Bytes("fork"));
    const home = "0x" + "cd".repeat(32);
    const message = coder.encode(
      ["bytes32", "address", "uint256", "bytes32"],
      [ref, recipient.address, committed, home],
    );

    await expect(
      sale.connect(vault).cfReceive(HOME_CHAIN, "0x00", message, ARBITRUM_ONE.usdc, amount),
    )
      .to.emit(sale, "SalePaid")
      .withArgs(ref, recipient.address, committed, amount - committed);

    expect(await usdc.balanceOf(recipient.address)).to.equal(committed);
    expect(await sale.dust()).to.equal(amount - committed);
  });
});
