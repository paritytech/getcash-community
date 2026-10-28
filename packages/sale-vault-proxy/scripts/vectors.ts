import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "hardhat";
import {
  ARBITRUM_ONE,
  ARBITRUM_SEPOLIA,
  PRICE_FLOOR_BPS,
  RETRY_BLOCKS,
  factoryConfig,
  networkVectors,
} from "../config/networks";
import previous from "../vectors.json";
import {
  BROKER_MAINNET,
  BROKER_TESTNET,
  CLAIMER,
  cloneArgs,
  deploySystem,
  encodeMessage,
  initcodeHash,
  minPriceX128,
  predictProxy,
  proxySalt,
  refOf,
  sell,
} from "../test/helpers";
import {
  ccmGasBudget,
  cfReceiveData,
  forkRig,
  forkUrl,
  freshAddress,
  liveL1Gas,
  measureGas,
} from "../test/measure";

// Writes vectors.json, the literals both repos' TS tests copy. Gas is measured on real USDC, so run it on the fork
const OUT = join(__dirname, "..", "vectors.json");

// 2027-01-01T00:00:00.500Z in epoch ms, so the app encoder's round down to seconds is pinned too
const PAYMENT_EXPIRES_AT = 1_798_761_600_500;
const DEADLINE = BigInt(Math.floor(PAYMENT_EXPIRES_AT / 1000));

const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main() {
  const url = forkUrl();
  const forkBlock = await ethers.provider.getBlockNumber();
  const s = await deploySystem();
  const factory = await s.factory.getAddress();
  const implementation = await s.factory.IMPLEMENTATION();

  // Pinned vectors from fixed addresses, plus one the local factory confirms
  const pinnedClaimer = "0x3333333333333333333333333333333333333333";
  const pinned = [
    "0x" + "ab".repeat(32),
    "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
  ].map((home) => {
    const f = "0x1111111111111111111111111111111111111111";
    const i = "0x2222222222222222222222222222222222222222";
    return {
      factory: f,
      implementation: i,
      home,
      claimer: pinnedClaimer,
      args: cloneArgs(home, pinnedClaimer).toLowerCase(),
      salt: proxySalt(home, pinnedClaimer),
      initcodeHash: initcodeHash(i, home, pinnedClaimer),
      proxy: predictProxy(f, i, home, pinnedClaimer),
    };
  });
  const localHome = ethers.keccak256(ethers.toUtf8Bytes("vectors"));
  const localProxy = await s.factory.predict(localHome, CLAIMER);
  if (localProxy !== predictProxy(factory, implementation, localHome, CLAIMER))
    throw new Error("vectors: factory.predict disagrees with the TS formula");
  await s.factory.deploy(localHome, CLAIMER);
  const localCode = await ethers.provider.getCode(localProxy);
  if (ethers.dataSlice(localCode, 0x2d) !== cloneArgs(localHome, CLAIMER).toLowerCase())
    throw new Error("vectors: deployed clone args disagree with the TS formula");

  const selectorOf = (sig: string) => ethers.id(sig).slice(0, 10);
  const selectors: Record<string, string> = {};
  for (const iface of [s.factory.interface, s.implementation.interface]) {
    iface.forEachFunction((fn) => {
      selectors[fn.format("sighash")] = fn.selector;
    });
  }
  selectors["balanceOf(address)"] = selectorOf("balanceOf(address)");
  selectors["xSwapToken(uint32,bytes,uint32,address,uint256,bytes)"] = selectorOf(
    "xSwapToken(uint32,bytes,uint32,address,uint256,bytes)",
  );
  const events: Record<string, string> = {};
  for (const iface of [s.factory.interface, s.implementation.interface]) {
    iface.forEachEvent((ev) => {
      events[ev.format("sighash")] = ev.topicHash;
    });
  }

  // A paid sale plus a little extra, so state() and delivery() carry every kind of value
  const { home: stateHome, proxy } = await sell(s, "state-sample", 50_000_000n, 50_400_000n);
  await s.usdc.mint(await proxy.getAddress(), 100_000n);
  const proxyAddress = await proxy.getAddress();
  const stateRaw = await ethers.provider.call({
    to: proxyAddress,
    data: proxy.interface.encodeFunctionData("state"),
  });
  const st = await proxy.state();
  const deliveryArgs = [refOf("state-sample"), s.recipient.address, 50_000_000n] as const;
  const deliveryRaw = await ethers.provider.call({
    to: proxyAddress,
    data: proxy.interface.encodeFunctionData("delivery", [...deliveryArgs]),
  });
  const dv = await proxy.delivery(...deliveryArgs);

  // cf_parameters vectors that match the backend /api/encodeCfParameters bytes
  const harness = await (await ethers.getContractFactory("CfParametersHarness")).deploy();
  const refund = "0x1234567890AbcdEF1234567890aBcdef12345678";
  const vectorPrice = minPriceX128(10_000_000n, PRICE_FLOOR_BPS, 0n);
  const derivedProxy = "0xfb63126B916e3bD2497702a0139AD2B344aC7536";
  const derivedPrice = minPriceX128(20_000_000n, PRICE_FLOOR_BPS, ARBITRUM_ONE.feeAllowance);
  const cfParameters = {
    testnet: {
      retryBlocks: RETRY_BLOCKS,
      refund,
      minPriceX128: vectorPrice,
      broker: BROKER_TESTNET,
      bytes: await harness.encode(RETRY_BLOCKS, refund, vectorPrice, BROKER_TESTNET),
    },
    mainnet: {
      retryBlocks: RETRY_BLOCKS,
      refund,
      minPriceX128: vectorPrice,
      broker: BROKER_MAINNET,
      bytes: await harness.encode(RETRY_BLOCKS, refund, vectorPrice, BROKER_MAINNET),
    },
    derived: {
      amount: 20_000_000n,
      floorBps: PRICE_FLOOR_BPS,
      feeAllowance: ARBITRUM_ONE.feeAllowance,
      retryBlocks: RETRY_BLOCKS,
      refund: derivedProxy,
      minPriceX128: derivedPrice,
      broker: BROKER_MAINNET,
      bytes: await harness.encode(RETRY_BLOCKS, derivedProxy, derivedPrice, BROKER_MAINNET),
    },
  };

  // Gas on the real Vault and Circle USDC, with the L1 part priced by live Arbitrum
  const [, treasury] = await ethers.getSigners();
  const real = await (
    await ethers.getContractFactory("SaleVaultProxyFactory")
  ).deploy(factoryConfig(ARBITRUM_ONE, treasury.address, treasury.address));
  const rig = await forkRig(real, ARBITRUM_ONE);
  const gas = await measureGas(rig);
  const deliveryGas = await real.DELIVERY_GAS();
  const proxyCallGas = await real.PROXY_CALL_GAS();
  if (deliveryGas < gas.deliveryGas || proxyCallGas < gas.proxyCallGas)
    throw new Error(
      `vectors: set DELIVERY_GAS >= ${gas.deliveryGas} and PROXY_CALL_GAS >= ${gas.proxyCallGas}`,
    );
  const sample = encodeMessage(refOf("l1"), freshAddress(), 50_000_000n, ethers.ZeroHash);
  if (ethers.dataLength(sample) !== 192) throw new Error("vectors: the L1 sample is not 192 bytes");
  const liveL1 = await liveL1Gas(url, treasury.address, cfReceiveData(rig, sample, 50_000_000n));
  // The highest L1 sample seen, so a quiet moment never lowers the CCM budget
  const l1Gas = liveL1 > BigInt(previous.gas.l1Gas) ? liveL1 : BigInt(previous.gas.l1Gas);

  const out = {
    predict: {
      pinned,
      local: {
        factory,
        implementation,
        home: localHome,
        claimer: CLAIMER,
        args: cloneArgs(localHome, CLAIMER).toLowerCase(),
        salt: proxySalt(localHome, CLAIMER),
        proxy: localProxy,
      },
    },
    message: {
      fundingRequestId: "funding-1",
      ref: refOf("funding-1"),
      recipient: "0x1111111111111111111111111111111111111111",
      committed: 50_000_000n,
      home: "0x" + "ab".repeat(32),
      paymentExpiresAt: PAYMENT_EXPIRES_AT,
      deadline: DEADLINE,
      claimer: pinnedClaimer,
      encoded: encodeMessage(
        refOf("funding-1"),
        "0x1111111111111111111111111111111111111111",
        50_000_000n,
        "0x" + "ab".repeat(32),
        DEADLINE,
        pinnedClaimer,
      ),
    },
    selectors,
    events,
    state: {
      proxy: proxyAddress,
      raw: stateRaw,
      decoded: {
        home: st[0],
        claimer: st[1],
        balance: st[2],
        attempts: st[3],
        lastReturnAt: st[4],
        nextReturnAt: st[5],
        releaseAt: st[6],
        releasable: st[7],
      },
    },
    delivery: {
      proxy: proxyAddress,
      home: stateHome,
      ref: deliveryArgs[0],
      recipient: deliveryArgs[1],
      committed: deliveryArgs[2],
      raw: deliveryRaw,
      decoded: { status: dv[0], amount: dv[1], leftover: dv[2] },
    },
    cfParameters,
    gas: {
      DELIVERY_GAS: deliveryGas,
      PROXY_CALL_GAS: proxyCallGas,
      CCM_GAS_BUDGET: ccmGasBudget(gas.cfReceiveMax, deliveryGas, l1Gas),
      forkBlock,
      l1Gas,
      measured: gas,
    },
    // Per Arbitrum chain id, config.test checks it against config/networks.ts
    networks: Object.fromEntries(
      [ARBITRUM_ONE, ARBITRUM_SEPOLIA].map((n) => [n.chainId, networkVectors(n)]),
    ),
  };
  const text = json(out);
  writeFileSync(OUT, text + "\n");
  console.info(text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
