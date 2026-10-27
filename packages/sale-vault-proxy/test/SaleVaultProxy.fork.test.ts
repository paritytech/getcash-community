import { expect } from "chai";
import { ethers, network } from "hardhat";
import vectors from "../vectors.json";
import { liveProblems } from "../config/chainflip";
import { ARBITRUM_ONE, ARBITRUM_SEPOLIA, CCM_GAS_BUDGET, factoryConfig } from "../config/networks";
import { CLAIMER, encodeCfParameters, encodeMessage, homeOf, minPriceX128, refOf } from "./helpers";
import {
  ccmGasBudget,
  cfReceiveData,
  forkRig,
  forkUrl,
  freshAddress,
  intrinsicGas,
  liveL1Gas,
  measureGas,
  receive,
  sweepCfReceive,
  sweepDeliver,
  type GasReport,
  type Rig,
} from "./measure";

// Runs only on an Arbitrum One fork (ARBITRUM_FORK=1), against the real Vault and Circle USDC
const FORK = !!(network.config as { forking?: unknown }).forking;

// The Vault's SwapToken event, sender indexed, as chainflip-eth-contracts IVault declares it
const SWAP_TOKEN = "SwapToken(uint32,bytes,uint32,address,uint256,address,bytes)";

(FORK ? describe : describe.skip)("SaleVaultProxy (Arbitrum One fork, real USDC)", function () {
  this.timeout(1_800_000);
  let rig: Rig;
  let report: GasReport;

  before(async () => {
    const [, treasury] = await ethers.getSigners();
    const factory = await (
      await ethers.getContractFactory("SaleVaultProxyFactory")
    ).deploy(factoryConfig(ARBITRUM_ONE, treasury.address, treasury.address));
    rig = await forkRig(factory, ARBITRUM_ONE);
  });

  it("each network's config holds against live Chainflip limits", async () => {
    expect(await liveProblems(ARBITRUM_ONE)).to.deep.equal([]);
    expect(await liveProblems(ARBITRUM_SEPOLIA)).to.deep.equal([]);
  });

  it("the Vault and USDC are live contracts", async () => {
    expect(await ethers.provider.getCode(ARBITRUM_ONE.vault)).to.not.equal("0x");
    const usdc = new ethers.Contract(
      ARBITRUM_ONE.usdc,
      ["function symbol() view returns (string)"],
      ethers.provider,
    );
    expect(await usdc.symbol()).to.equal("USDC");
  });

  it("pays the provider from the proxy in real USDC", async () => {
    const payee = freshAddress();
    const committed = 30_000_000n;
    const tx = await receive(
      rig,
      encodeMessage(refOf("fork-pay"), payee, committed, homeOf("fork-pay")),
      committed + 200_000n,
    );
    const receipt = await tx.wait();
    const usdc = await ethers.getContractAt("IERC20", ARBITRUM_ONE.usdc);
    const transfer = receipt!.logs
      .filter((l) => l.address.toLowerCase() === ARBITRUM_ONE.usdc.toLowerCase())
      .map((l) => usdc.interface.parseLog(l))
      .find((l) => l?.name === "Transfer" && l.args.to === payee);
    expect(transfer?.args.from).to.equal(await rig.factory.predict(homeOf("fork-pay"), CLAIMER));
    expect(await usdc.balanceOf(payee)).to.equal(committed);
  });

  it("the gas constants cover every path measured on real USDC", async () => {
    report = await measureGas(rig);
    const deliveryGas = await rig.factory.DELIVERY_GAS();
    expect(deliveryGas >= report.deliveryGas).to.equal(true);
    expect((await rig.factory.PROXY_CALL_GAS()) >= report.proxyCallGas).to.equal(true);
    expect(report.deferFloor < deliveryGas).to.equal(true);
    expect(CCM_GAS_BUDGET >= ccmGasBudget(report.cfReceiveMax, deliveryGas, 0n)).to.equal(true);
    expect(BigInt(vectors.gas.CCM_GAS_BUDGET)).to.equal(CCM_GAS_BUDGET);
  });

  it("a delivery given the CCM budget pays after the 63/64 cut and ten times the live L1 cost", async () => {
    const payee = freshAddress();
    const message = encodeMessage(refOf("fork-budget"), payee, 30_000_000n, homeOf("fork-budget"));
    const data = cfReceiveData(rig, message, 30_000_000n);
    const l1 = await liveL1Gas(forkUrl(), payee, data);
    const gas = ((CCM_GAS_BUDGET - 10n * l1) * 63n) / 64n;
    const receipt = await (
      await receive(rig, message, 30_000_000n, intrinsicGas(data) + gas)
    ).wait();
    const names = receipt!.logs.map((l) => rig.factory.interface.parseLog(l)?.name);
    expect(names).to.include("Delivered");
    expect(names).to.not.include("DeliveryDeferred");
  });

  it("cfReceive defers or pays at every gas from the floor up on real USDC", async () => {
    expect(await sweepCfReceive(rig, report.deferFloor)).to.deep.equal([]);
  });

  it("a low-gas submit then deliver pays exactly once on real USDC", async () => {
    expect(await sweepDeliver(rig, report.deferFloor)).to.deep.equal([]);
  });

  it("returns a held sale through the real Vault with the exact destination and cfParameters", async () => {
    const amount = 25_000_000n;
    const home = homeOf("fork-held");
    await receive(
      rig,
      encodeMessage(refOf("fork-held"), freshAddress(), 30_000_000n, home),
      amount,
    );
    const proxy = await rig.factory.predict(home, CLAIMER);
    const p = await ethers.getContractAt("SaleVaultProxy", proxy);
    const receipt = await (await p.returnHome()).wait();
    const log = receipt!.logs.find(
      (l) =>
        l.address.toLowerCase() === ARBITRUM_ONE.vault.toLowerCase() &&
        l.topics[0] === ethers.id(SWAP_TOKEN),
    );
    if (!log) throw new Error("no SwapToken event");
    expect(ethers.getAddress(ethers.dataSlice(log.topics[1], 12))).to.equal(proxy);
    const [dstChain, dstAddress, dstToken, srcToken, swapAmount, cfParameters] =
      ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint32", "bytes", "uint32", "address", "uint256", "bytes"],
        log.data,
      );
    const minPrice = minPriceX128(amount, ARBITRUM_ONE.priceFloorBps, ARBITRUM_ONE.feeAllowance);
    expect(dstChain).to.equal(BigInt(ARBITRUM_ONE.homeChain));
    expect(dstAddress).to.equal(home);
    expect(dstToken).to.equal(BigInt(ARBITRUM_ONE.homeToken));
    expect(srcToken).to.equal(ethers.getAddress(ARBITRUM_ONE.usdc));
    expect(swapAmount).to.equal(amount);
    // The V1 layout field by field, then whole against the TS encoder
    const le = (hex: string) => BigInt("0x" + (hex.slice(2).match(/../g) ?? []).reverse().join(""));
    expect(ethers.dataLength(cfParameters)).to.equal(96);
    expect(ethers.dataSlice(cfParameters, 0, 1)).to.equal("0x01");
    expect(le(ethers.dataSlice(cfParameters, 1, 5))).to.equal(BigInt(ARBITRUM_ONE.retryBlocks));
    expect(ethers.getAddress(ethers.dataSlice(cfParameters, 5, 25))).to.equal(proxy);
    expect(le(ethers.dataSlice(cfParameters, 25, 57))).to.equal(minPrice);
    expect(ethers.dataSlice(cfParameters, 57, 61)).to.equal("0x00000000");
    expect(ethers.dataSlice(cfParameters, 61, 93)).to.equal(ARBITRUM_ONE.broker);
    expect(ethers.dataSlice(cfParameters, 93, 96)).to.equal("0x000000");
    const expected = encodeCfParameters(
      ARBITRUM_ONE.retryBlocks,
      proxy,
      minPrice,
      ARBITRUM_ONE.broker,
    );
    expect(cfParameters).to.equal(expected);

    // The backend encoder returns the same bytes
    const res = await fetch(new URL("/api/encodeCfParameters", ARBITRUM_ONE.swapApi), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcAsset: { chain: "Arbitrum", asset: "USDC" },
        destAsset: { chain: "Assethub", asset: "USDT" },
        srcAddress: proxy,
        destAddress: home,
        amount: amount.toString(),
        commissionBps: 0,
        fillOrKillParams: {
          retryDurationBlocks: ARBITRUM_ONE.retryBlocks,
          refundAddress: proxy,
          minPriceX128: minPrice.toString(),
          maxOraclePriceSlippage: null,
          refundCcmMetadata: null,
        },
      }),
    });
    expect(res.status).to.equal(200);
    expect(String(await res.json()).toLowerCase()).to.equal(expected);
  });
});
