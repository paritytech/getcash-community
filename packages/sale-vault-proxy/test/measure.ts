import { ethers, network } from "hardhat";
import { impersonateAccount, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import type { ContractTransactionResponse, TransactionReceipt } from "ethers";
import { ARBITRUM_NODE_INTERFACE, type SaleVaultProxyNetwork } from "../config/networks";
import type { SaleVaultProxyFactory } from "../typechain-types";
import {
  CLAIMER,
  FAR_DEADLINE,
  SRC_ADDR,
  SRC_CHAIN,
  encodeMessage,
  homeOf,
  refOf,
  type System,
} from "./helpers";

// Gas a transaction spends before execution: the base cost plus calldata
export function intrinsicGas(data: string): bigint {
  let gas = 21_000n;
  for (const byte of ethers.getBytes(data)) gas += byte === 0 ? 4n : 16n;
  return gas;
}

async function executionGas(tx: ContractTransactionResponse): Promise<bigint> {
  const receipt = await tx.wait();
  if (!receipt) throw new Error("no receipt");
  return receipt.gasUsed - intrinsicGas(tx.data);
}

export async function asSigner(address: string) {
  await impersonateAccount(address);
  await setBalance(address, ethers.parseEther("10"));
  return ethers.getSigner(address);
}

function roundUp(value: bigint, step: bigint): bigint {
  return ((value + step - 1n) / step) * step;
}

const max = (values: bigint[]) => values.reduce((a, b) => (a > b ? a : b));

// The CCM gas budget: half again the worst cfReceive plus its L1 part, and at least 40k over DELIVERY_GAS
export function ccmGasBudget(cfReceiveMax: bigint, deliveryGas: bigint, l1Gas: bigint): bigint {
  const budget = roundUp(((cfReceiveMax + l1Gas) * 15n) / 10n, 5_000n);
  return budget > deliveryGas + 40_000n ? budget : deliveryGas + 40_000n;
}

const NODE_INTERFACE = new ethers.Interface([
  "function gasEstimateComponents(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

// The L1 gas live Arbitrum charges a transaction carrying this calldata, to is any codeless address
export async function liveL1Gas(rpcUrl: string, to: string, data: string): Promise<bigint> {
  const raw = await new ethers.JsonRpcProvider(rpcUrl).call({
    to: ARBITRUM_NODE_INTERFACE,
    data: NODE_INTERFACE.encodeFunctionData("gasEstimateComponents", [to, false, data]),
  });
  return NODE_INTERFACE.decodeFunctionResult("gasEstimateComponents", raw)[1];
}

// The URL the in-process node forks, set only when ARBITRUM_FORK is
export function forkUrl(): string {
  const forking = (network.config as { forking?: { url: string } }).forking;
  if (!forking) throw new Error("set ARBITRUM_FORK=1 to fork Arbitrum One");
  return forking.url;
}

export function cfReceiveData(rig: Rig, message: string, amount: bigint): string {
  return rig.factory.interface.encodeFunctionData("cfReceive", [
    SRC_CHAIN,
    SRC_ADDR,
    message,
    rig.usdc,
    amount,
  ]);
}

// A deployed factory plus how to fund and freeze addresses on its USDC, mocked or real
export interface Rig {
  factory: SaleVaultProxyFactory;
  usdc: string;
  vault: string;
  fund(to: string, amount: bigint): Promise<unknown>;
  block(who: string, blocked: boolean): Promise<unknown>;
}

export function mockRig(s: System): Rig {
  return {
    factory: s.factory,
    usdc: s.net.usdc,
    vault: s.net.vault,
    fund: (to, amount) => s.usdc.mint(to, amount),
    block: (who, blocked) => s.usdc.setBlocked(who, blocked),
  };
}

const FIAT_TOKEN = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function blacklister() view returns (address)",
  "function blacklist(address)",
  "function unBlacklist(address)",
];

// Real Circle USDC: the Vault's own balance funds deliveries, its blacklister freezes addresses
export async function forkRig(
  factory: SaleVaultProxyFactory,
  net: SaleVaultProxyNetwork,
): Promise<Rig> {
  const vault = await asSigner(net.vault);
  const token = new ethers.Contract(net.usdc, FIAT_TOKEN, ethers.provider);
  const blacklister = await asSigner(await token.blacklister());
  const fiat = token.connect(blacklister) as typeof token;
  return {
    factory,
    usdc: net.usdc,
    vault: net.vault,
    fund: async (to, amount) =>
      (await (token.connect(vault) as typeof token).transfer(to, amount)).wait(),
    block: async (who, blocked) =>
      (await (blocked ? fiat.blacklist(who) : fiat.unBlacklist(who))).wait(),
  };
}

// Funds the factory then calls cfReceive from the Vault address, as the Vault does
export async function receive(
  rig: Rig,
  message: string,
  amount: bigint,
  gasLimit?: bigint,
): Promise<ContractTransactionResponse> {
  const vault = await asSigner(rig.vault);
  await rig.fund(await rig.factory.getAddress(), amount);
  return rig.factory
    .connect(vault)
    .cfReceive(
      SRC_CHAIN,
      SRC_ADDR,
      message,
      rig.usdc,
      amount,
      gasLimit === undefined ? {} : { gasLimit },
    );
}

let seq = 0;
// A recipient no test has touched, so its USDC balance slot is cold and empty
export function freshAddress(): string {
  return ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0xbeef0000 + ++seq), 20));
}

// What a cfReceive or deliver at a given gas limit ended in
export type Outcome = "paid" | "deferred" | "revert" | string;

function outcomeOf(rig: Rig, receipt: TransactionReceipt | null, paid: boolean): Outcome {
  const names = (receipt?.logs ?? [])
    .map((l) => rig.factory.interface.parseLog(l)?.name)
    .filter((n): n is string => !!n);
  if (names.includes("DeliveryDeferred") && names.length === 1) return "deferred";
  if (names.includes("Delivered") && paid) return "paid";
  return names.join(",") || "none";
}

const balanceOf = (rig: Rig, who: string): Promise<bigint> =>
  new ethers.Contract(rig.usdc, FIAT_TOKEN, ethers.provider).balanceOf(who);

async function attempt(rig: Rig, send: () => Promise<ContractTransactionResponse>, payee: string) {
  const before = await balanceOf(rig, payee);
  try {
    const receipt = await (await send()).wait();
    return outcomeOf(rig, receipt, (await balanceOf(rig, payee)) > before);
  } catch {
    return "revert";
  }
}

// Gas limits to try: coarse from the floor, fine around DELIVERY_GAS
function limits(from: bigint, deliveryGas: bigint): bigint[] {
  const out: bigint[] = [];
  for (let g = from; g <= deliveryGas + 100_000n; g += 2_500n) out.push(g);
  for (let g = deliveryGas - 5_000n; g <= deliveryGas + 5_000n; g += 250n) out.push(g);
  return out.sort((a, b) => (a < b ? -1 : 1));
}

// Every execution gas from the floor up must defer or pay a fresh sale, never unbook, pend or revert
export async function sweepCfReceive(rig: Rig, floor: bigint) {
  const deliveryGas = await rig.factory.DELIVERY_GAS();
  const payee = freshAddress();
  const message = encodeMessage(refOf("sweep"), payee, 50_000_000n, homeOf("sweep"));
  const base = intrinsicGas(cfReceiveData(rig, message, 50_500_000n));
  const bad: string[] = [];
  for (const g of limits(floor, deliveryGas)) {
    const snap = await network.provider.send("evm_snapshot");
    const outcome = await attempt(rig, () => receive(rig, message, 50_500_000n, base + g), payee);
    await network.provider.send("evm_revert", [snap]);
    if (outcome !== "paid" && outcome !== "deferred") bad.push(`${g}:${outcome}`);
  }
  return bad;
}

// Every gas limit for deliver must pay the deferred sale or revert whole, never unbook or pend
export async function sweepDeliver(rig: Rig, floor: bigint) {
  const deliveryGas = await rig.factory.DELIVERY_GAS();
  const payee = freshAddress();
  const home = homeOf("sweep-deliver");
  const ref = refOf("sweep-deliver");
  const message = encodeMessage(ref, payee, 50_000_000n, home);
  await receive(
    rig,
    message,
    50_500_000n,
    intrinsicGas(cfReceiveData(rig, message, 50_500_000n)) + floor,
  );
  if (
    (await rig.factory.pendingDelivery(home, CLAIMER, ref, payee, 50_000_000n, FAR_DEADLINE)) === 0n
  )
    throw new Error("sweepDeliver: the setup delivery did not defer");
  const data = rig.factory.interface.encodeFunctionData("deliver", [
    home,
    CLAIMER,
    ref,
    payee,
    50_000_000n,
    FAR_DEADLINE,
  ]);
  const base = intrinsicGas(data);
  const bad: string[] = [];
  for (const g of limits(30_000n, deliveryGas)) {
    const snap = await network.provider.send("evm_snapshot");
    const outcome = await attempt(
      rig,
      () =>
        rig.factory.deliver(home, CLAIMER, ref, payee, 50_000_000n, FAR_DEADLINE, {
          gasLimit: base + g,
        }),
      payee,
    );
    await network.provider.send("evm_revert", [snap]);
    if (outcome !== "paid" && outcome !== "revert") bad.push(`${g}:${outcome}`);
  }
  return bad;
}

// Least execution gas at which cfReceive books a delivery instead of reverting
export async function deferFloor(rig: Rig): Promise<bigint> {
  const message = encodeMessage(refOf("floor"), freshAddress(), 50_000_000n, homeOf("floor"));
  const vault = await asSigner(rig.vault);
  // The funding is only for the search, so it is rolled back after
  const snap = await network.provider.send("evm_snapshot");
  await rig.fund(await rig.factory.getAddress(), 50_000_000n);
  const base = intrinsicGas(cfReceiveData(rig, message, 50_000_000n));
  const ok = (gasLimit: bigint) =>
    rig.factory
      .connect(vault)
      .cfReceive.staticCall(SRC_CHAIN, SRC_ADDR, message, rig.usdc, 50_000_000n, { gasLimit })
      .then(
        () => true,
        () => false,
      );
  let lo = base;
  let hi = base + 200_000n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await ok(mid)) hi = mid;
    else lo = mid;
  }
  await network.provider.send("evm_revert", [snap]);
  return hi - base;
}

export interface GasReport {
  cfReceive: {
    freshPay: bigint;
    freshShort: bigint;
    freshPayoutFailed: bigint;
    freshExpired: bigint;
    existingPay: bigint;
  };
  deliver: bigint;
  cfReceiveMax: bigint;
  onDeliveryMax: bigint;
  deliveryGas: bigint;
  proxyCallGas: bigint;
  deferFloor: bigint;
  returnHome: bigint;
  release: bigint;
  expireDeferred: bigint;
  flush: bigint;
  flushDeploy: bigint;
  flushFallback: bigint;
}

// Every gas number the constants rest on, on whatever USDC the rig runs
export async function measureGas(rig: Rig): Promise<GasReport> {
  // Paths that pay a claimer get a cold one, so its USDC slot starts empty
  const claimers: Record<string, string> = {
    "g-release": freshAddress(),
    "g-fallback": freshAddress(),
  };
  const claimerOf = (id: string) => claimers[id] ?? CLAIMER;
  const messageOf = (id: string, payee: string, deadline: bigint) =>
    encodeMessage(refOf(id), payee, 50_000_000n, homeOf(id), deadline, claimerOf(id));
  const sale = (id: string, payee: string, amount: bigint, deadline = FAR_DEADLINE) =>
    receive(rig, messageOf(id, payee, deadline), amount);

  const freshPay = await executionGas(await sale("g-pay", freshAddress(), 50_500_000n));
  const freshShort = await executionGas(await sale("g-short", freshAddress(), 49_000_000n));
  const blocked = freshAddress();
  await rig.block(blocked, true);
  const freshPayoutFailed = await executionGas(await sale("g-blocked", blocked, 50_500_000n));
  const freshExpired = await executionGas(await sale("g-expired", freshAddress(), 50_500_000n, 1n));
  await rig.factory.deploy(homeOf("g-existing"), CLAIMER);
  const existingPay = await executionGas(await sale("g-existing", freshAddress(), 50_500_000n));
  const cfReceiveMax = max([freshPay, freshShort, freshPayoutFailed, freshExpired, existingPay]);

  // A delivery deferred for gas, then replayed into a fresh proxy and a fresh payee
  const floor = await deferFloor(rig);
  const defer = async (id: string, payee: string, deadline = FAR_DEADLINE) => {
    const message = messageOf(id, payee, deadline);
    await receive(
      rig,
      message,
      50_500_000n,
      intrinsicGas(cfReceiveData(rig, message, 50_500_000n)) + floor,
    );
  };
  const payee = freshAddress();
  await defer("g-deliver", payee);
  const deliver = await executionGas(
    await rig.factory.deliver(
      homeOf("g-deliver"),
      CLAIMER,
      refOf("g-deliver"),
      payee,
      50_000_000n,
      FAR_DEADLINE,
    ),
  );

  // onDelivery straight from the factory address, cold USDC included, so an upper bound
  const factorySigner = await asSigner(await rig.factory.getAddress());
  const onDeliveryRuns: bigint[] = [];
  for (const [id, blockedPayee] of [
    ["o-pay", false],
    ["o-blocked", true],
  ] as const) {
    const home = homeOf(id);
    await rig.factory.deploy(home, CLAIMER);
    const proxy = await ethers.getContractAt(
      "SaleVaultProxy",
      await rig.factory.predict(home, CLAIMER),
    );
    await rig.fund(await proxy.getAddress(), 50_500_000n);
    const to = freshAddress();
    if (blockedPayee) await rig.block(to, true);
    onDeliveryRuns.push(
      await executionGas(
        await proxy
          .connect(factorySigner)
          .onDelivery(refOf(id), to, 50_000_000n, 50_500_000n, FAR_DEADLINE),
      ),
    );
  }

  const proxyOf = async (id: string) =>
    ethers.getContractAt("SaleVaultProxy", await rig.factory.predict(homeOf(id), claimerOf(id)));
  await sale("g-held", freshAddress(), 40_000_000n);
  const returnHome = await executionGas(await (await proxyOf("g-held")).returnHome());

  // A held balance below MIN_RETURN, released to a cold claimer after RELEASE_DELAY
  await sale("g-release", freshAddress(), 5_000_000n);
  const releaseProxy = await proxyOf("g-release");
  await time.increase(await releaseProxy.RELEASE_DELAY());
  const release = await executionGas(await releaseProxy.release());

  // A move into the proxy refused by USDC books funds-only pending, then flush moves it
  const frozenProxy = await rig.factory.predict(homeOf("g-flush"), CLAIMER);
  await rig.block(frozenProxy, true);
  await sale("g-flush", freshAddress(), 50_000_000n);
  await rig.block(frozenProxy, false);
  const flush = await executionGas(await rig.factory.flush(homeOf("g-flush"), CLAIMER));

  // Deferred sales past their deadline go to pending, then flush deploys the proxy or pays the claimer
  const deadline = BigInt(await time.latest()) + 3_600n;
  const expired: Record<string, string> = {};
  for (const id of ["g-expire", "g-fallback"]) {
    expired[id] = freshAddress();
    await defer(id, expired[id], deadline);
  }
  await time.increaseTo(deadline + 1n);
  const expire = (id: string) =>
    rig.factory.expireDeferred(
      homeOf(id),
      claimerOf(id),
      refOf(id),
      expired[id],
      50_000_000n,
      deadline,
    );
  const expireDeferred = await executionGas(await expire("g-expire"));
  const flushDeploy = await executionGas(await rig.factory.flush(homeOf("g-expire"), CLAIMER));
  await expire("g-fallback");
  await rig.block(await rig.factory.predict(homeOf("g-fallback"), claimerOf("g-fallback")), true);
  const flushFallback = await executionGas(
    await rig.factory.flush(homeOf("g-fallback"), claimerOf("g-fallback")),
  );

  const deliveryGas = roundUp(
    (max([cfReceiveMax, deliver, flushDeploy, flushFallback]) * 12n) / 10n,
    5_000n,
  );
  const onDeliveryMax = max(onDeliveryRuns);
  return {
    cfReceive: { freshPay, freshShort, freshPayoutFailed, freshExpired, existingPay },
    deliver,
    cfReceiveMax,
    onDeliveryMax,
    deliveryGas,
    proxyCallGas: roundUp((onDeliveryMax * 13n) / 10n, 1_000n),
    deferFloor: floor,
    returnHome,
    release,
    expireDeferred,
    flush,
    flushDeploy,
    flushFallback,
  };
}
