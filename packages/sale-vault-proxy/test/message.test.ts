import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import vectors from "../vectors.json";
import { CLAIMER, FAR_DEADLINE, deliver, deploySystem, encodeMessage, refOf } from "./helpers";

// Shared with the app encoder: if this vector changes, packages/chainflip ccm.ts must change too
const VECTOR =
  "0xc0615bcc697a20445b853b8779e01ab7c45752dbd7ab43f9c3dc100a83e5b52c00000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000002faf080abababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000006b36ec800000000000000000000000003333333333333333333333333333333333333333";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const HOME = "0x" + "ab".repeat(32);
const VECTOR_CLAIMER = "0x3333333333333333333333333333333333333333";
// 2027-01-01 in unix seconds
const DEADLINE = 1_798_761_600n;

describe("sale message", () => {
  it("encodes the vector in exactly 192 bytes, claimer last", () => {
    const message = encodeMessage(
      refOf("funding-1"),
      RECIPIENT,
      50_000_000n,
      HOME,
      DEADLINE,
      VECTOR_CLAIMER,
    );
    expect(message).to.equal(VECTOR);
    expect(ethers.dataLength(message)).to.equal(192);
    expect(ethers.dataSlice(message, 160)).to.equal(ethers.zeroPadValue(VECTOR_CLAIMER, 32));
  });

  it("is the vector vectors.json hands the app encoder", () => {
    expect(vectors.message.encoded).to.equal(VECTOR);
    expect(BigInt(vectors.message.deadline)).to.equal(DEADLINE);
  });

  it("the factory decodes the vector into Delivered", async () => {
    const s = await loadFixture(deploySystem);
    await time.setNextBlockTimestamp(DEADLINE);
    const proxy = await s.factory.predict(HOME, VECTOR_CLAIMER);
    await expect(deliver(s, VECTOR, 50_000_000n))
      .to.emit(s.factory, "Delivered")
      .withArgs(
        HOME,
        proxy,
        refOf("funding-1"),
        VECTOR_CLAIMER,
        RECIPIENT,
        50_000_000n,
        50_000_000n,
      );
    expect(await s.usdc.balanceOf(RECIPIENT)).to.equal(50_000_000n);
  });

  it("masks a dirty address word", async () => {
    const s = await loadFixture(deploySystem);
    const ref = "0x" + "aa".repeat(32);
    const addrWord = "0x" + "de".repeat(12) + s.recipient.address.slice(2).toLowerCase();
    const message = ethers.concat([
      ref,
      addrWord,
      ethers.toBeHex(30_000_000n, 32),
      HOME,
      ethers.toBeHex(FAR_DEADLINE, 32),
      ethers.zeroPadValue(CLAIMER, 32),
    ]);
    await expect(deliver(s, message, 30_500_000n))
      .to.emit(s.factory, "Delivered")
      .withArgs(
        HOME,
        await s.factory.predict(HOME, CLAIMER),
        ref,
        CLAIMER,
        s.recipient.address,
        30_000_000n,
        30_500_000n,
      );
    expect(await s.usdc.balanceOf(s.recipient.address)).to.equal(30_000_000n);
  });
});

// The selectors the adapter and worker call by hand
const PROXY_SELECTORS: Record<string, string> = {
  "returnHome()": "0x2aadc832",
  "release()": "0x86d1a69f",
  "skimNative()": "0x544be958",
  "state()": "0xc19d93fb",
  "home()": "0x9fa92f9d",
  "claimer()": "0xd379be23",
  "releaseAt()": "0xae69ef4c",
  "delivery(bytes32,address,uint256)": "0xcf951176",
  "FACTORY()": "0x2dd31000",
  "BROKER()": "0xeae2396f",
  "RETRY_BLOCKS()": "0xf036a575",
  "MIN_RETURN()": "0x0151900d",
  "MAX_RETURN()": "0x90b18557",
  "PRICE_FLOOR_BPS()": "0xcf056f5b",
  "FEE_ALLOWANCE()": "0xd44b57ea",
  "RETURN_COOLDOWN()": "0x47446418",
  "RELEASE_DELAY()": "0xa302e232",
  "RELEASE_ATTEMPTS()": "0x3c0b1a93",
  "STALE_DELAY()": "0xa1f3888a",
  "HOME_CHAIN()": "0xf42ff394",
  "HOME_TOKEN()": "0xf2553acd",
};
const FACTORY_SELECTORS: Record<string, string> = {
  "deliver(bytes32,address,bytes32,address,uint256,uint256)": "0x67b12c52",
  "expireDeferred(bytes32,address,bytes32,address,uint256,uint256)": "0xae50b33c",
  "pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)": "0x4be199b9",
  "flush(bytes32,address)": "0xb026fd99",
  "deploy(bytes32,address)": "0x8c1fb931",
  "pending(bytes32,address)": "0xda4e6595",
  "predict(bytes32,address)": "0xc4b9f746",
  "retire()": "0xa4874d77",
  "retired()": "0x2eb38ae0",
  "GUARDIAN()": "0x724c184c",
  "skim()": "0x1dd19cb4",
  "totalPending()": "0x3f90916a",
  "IMPLEMENTATION()": "0x3a4741bd",
  "VAULT()": "0x411557d1",
  "USDC()": "0x89a30271",
  "TREASURY()": "0x2d2c5565",
  "DELIVERY_GAS()": "0x6a9aeb03",
  "cfReceive(uint32,bytes,bytes,address,uint256)": "0x4904ac5f",
};
const EXTERNAL_SELECTORS: Record<string, string> = {
  "balanceOf(address)": "0x70a08231",
  "xSwapToken(uint32,bytes,uint32,address,uint256,bytes)": "0x04fc7da0",
};

describe("selectors", () => {
  it("match the pinned list and exist on the contracts", async () => {
    const factory = await ethers.getContractFactory("SaleVaultProxyFactory");
    const proxy = await ethers.getContractFactory("SaleVaultProxy");
    const all = { ...PROXY_SELECTORS, ...FACTORY_SELECTORS, ...EXTERNAL_SELECTORS };
    for (const [sig, want] of Object.entries(all)) {
      expect(ethers.id(sig).slice(0, 10), sig).to.equal(want);
    }
    for (const sig of Object.keys(PROXY_SELECTORS)) {
      expect(proxy.interface.getFunction(sig), sig).to.not.equal(null);
    }
    for (const sig of Object.keys(FACTORY_SELECTORS)) {
      expect(factory.interface.getFunction(sig), sig).to.not.equal(null);
    }
  });
});
