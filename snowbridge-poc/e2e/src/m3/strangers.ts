import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { accountLocation } from "../../../assethub/src/location";
import { signedOriginNetwork } from "../../../assethub/src/network";
import { depositAll, encodeVersionedXcm } from "../../../assethub/src/xcm";
import { factoryAbi, forwarderAbi, registryAbi } from "../../../services/src/common/abi";
import { loadForwarderCreationCode } from "../../../services/src/common/artifacts";
import { connect as connectEthereum, deriveUser, predictDepositAddress } from "../../../services/src/user";
import { publicClient, tokenAbi, waitFor } from "../chains";
import { ETHEREUM_RPC } from "../config";
import { acceptedIn } from "../gateway";
import { ONE, balanceOf, fundOwner, payoutRecord, same } from "../harness";
import type { Scenario } from "../report";
import { notOursEvidence, type M3 } from "./evidence";

const gatewayAbi = parseAbi(["function v2_sendMessage(bytes xcm, bytes[] assets, bytes claimer, uint128 executionFee, uint128 relayerFee) payable"]);

export type Stranger = { name: string; nonce: bigint; tx: Hex; ss58: string; depositId?: bigint };
export type Strangers = { a: Stranger; b: Stranger; sentAt: number };

const WINDOW_MS = 6 * 60_000;

// 4a: an EOA calls the Gateway itself, so the message's origin is that EOA and not the router.
async function directGatewayMessage(m: M3, s: Scenario): Promise<Stranger> {
  const { ctx } = m;
  const user = deriveUser(`e2e-${ctx.runId}-stranger-a`);
  const amount = 5n * ONE;
  await fundOwner(ctx, user.owner.address, amount);
  const connection = await connectEthereum(ETHEREUM_RPC, user.owner);
  const approved = await connection.walletClient.writeContract({ address: ctx.dep.token, abi: tokenAbi, functionName: "approve", args: [ctx.dep.gateway, amount] } as never);
  await publicClient.waitForTransactionReceipt({ hash: approved });

  const xcm = encodeVersionedXcm(ctx.api, [depositAll(user.assetHubAccount)]);
  const claimer = ctx.api.createType("StagingXcmV5Location", accountLocation(user.assetHubAccount, await signedOriginNetwork(ctx.api))).toHex();
  const asset = encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint128" }], [0, ctx.dep.token, amount]);
  const executionFee = BigInt(ctx.dep.executionFeeWei);
  const tx = await connection.walletClient.writeContract({ address: ctx.dep.gateway, abi: gatewayAbi, functionName: "v2_sendMessage", args: [xcm, [asset], claimer, executionFee, 0n], value: executionFee });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  const accepted = acceptedIn(receipt, ctx.dep.gateway);
  s.ref("4a Gateway tx", tx);
  s.ref("4a Gateway nonce", accepted.nonce);
  s.ref("4a Ethereum block", receipt.blockNumber);
  s.check("4a: the message's origin is the stranger's own account, not the router, and its relayer fee is 0", same(accepted.origin, user.owner.address) && !same(accepted.origin, ctx.dep.router) && accepted.relayerFee === 0n, `origin ${accepted.origin}`);
  return { name: "4a direct Gateway message", nonce: accepted.nonce, tx, ss58: user.assetHubAddress };
}

// 4b: the stranger deploys a forwarder from our factory with their own owner key and triggers it themselves, so the origin is the router and the signer is not the trigger key.
async function ownForwarder(m: M3, s: Scenario, amount: bigint): Promise<Stranger> {
  const { ctx } = m;
  const user = deriveUser(`e2e-${ctx.runId}-stranger-b`);
  await fundOwner(ctx, user.owner.address, amount);
  const connection = await connectEthereum(ETHEREUM_RPC, user.owner);
  const forwarder: Address = predictDepositAddress({ factory: ctx.dep.factory, account: user.assetHubAccount, owner: user.owner.address, creationCode: loadForwarderCreationCode() });

  const deployed = await connection.walletClient.writeContract({ address: ctx.dep.factory, abi: factoryAbi, functionName: "deploy", args: [user.assetHubAccount, user.owner.address] });
  await publicClient.waitForTransactionReceipt({ hash: deployed });
  const transferred = await connection.walletClient.writeContract({ address: ctx.dep.token, abi: tokenAbi, functionName: "transfer", args: [forwarder, amount] } as never);
  await publicClient.waitForTransactionReceipt({ hash: transferred });

  const executionFee = BigInt(ctx.dep.executionFeeWei);
  const tx = await connection.walletClient.writeContract({ address: forwarder, abi: forwarderAbi, functionName: "trigger", args: [ctx.dep.token, executionFee, 0n], value: executionFee });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  const accepted = acceptedIn(receipt, ctx.dep.gateway);
  const signer = (await publicClient.getTransaction({ hash: tx })).from;
  const registryKey = await publicClient.readContract({ address: ctx.dep.registry, abi: registryAbi, functionName: "relayer", blockNumber: receipt.blockNumber });
  s.ref("4b forwarder", forwarder);
  s.ref("4b trigger tx", tx);
  s.ref("4b Gateway nonce", accepted.nonce);
  s.ref("4b Ethereum block", receipt.blockNumber);
  s.check("4b: the message's origin is the router and its relayer fee is 0", same(accepted.origin, ctx.dep.router) && accepted.relayerFee === 0n, `origin ${accepted.origin}`);
  s.check("4b: the transaction was signed by the stranger, not by the registry's trigger key", same(signer, user.owner.address) && !same(signer, registryKey), `signer ${signer}, trigger key ${registryKey}`);
  const depositId = BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [forwarder, 1n])));
  return { name: "4b stranger-triggered forwarder", nonce: accepted.nonce, tx, ss58: user.assetHubAddress, depositId };
}

export async function sendStrangers(m: M3, s: Scenario, amountB: bigint): Promise<Strangers> {
  const a = await directGatewayMessage(m, s);
  const b = await ownForwarder(m, s, amountB);
  return { a, b, sentAt: Date.now() };
}

// Waits for the observation window, then checks that nothing of theirs was delivered while ours were.
export async function verifyStrangers(m: M3, s: Scenario, st: Strangers): Promise<void> {
  const { ctx } = m;
  const record = await waitFor("the payout service's decision on the stranger deposit", async () => {
    const found = await payoutRecord(ctx, st.b.depositId!);
    return found?.status !== "queued" && found;
  }, 90_000);
  s.ref("4b payout service", `${record.status}: ${record.reason ?? ""}`);
  s.check("4b: the payout service recorded the stranger-triggered deposit as skipped and did not front it", record.status === "skipped" && /not triggered by our key/.test(String(record.reason)), `${record.status}: ${record.reason}`);

  const left = st.sentAt + WINDOW_MS - Date.now();
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  s.time("observation window", Date.now() - st.sentAt);
  await notOursEvidence(m, s, "4a", st.a.nonce);
  await notOursEvidence(m, s, "4b", st.b.nonce);

  s.check("4a: nothing reached the stranger's account on Asset Hub", (await balanceOf(ctx, st.a.ss58)) === 0n);
  s.check(
    "4b: nothing reached the stranger's account on Asset Hub, nobody fronted it, and the pool never settled its deposit",
    (await balanceOf(ctx, st.b.ss58)) === 0n && ctx.watcher.find("Settled", st.b.depositId!) === undefined && ctx.watcher.find("Fronted", st.b.depositId!) === undefined,
  );

  const highest = st.a.nonce > st.b.nonce ? st.a.nonce : st.b.nonce;
  const controls = m.delivered.filter((d) => d.nonce !== undefined && d.nonce > highest && ctx.watcher.find("Settled", d.depositId));
  s.check("the relayer was delivering in the same window: our messages with higher nonces were settled", controls.length > 0, controls.map((d) => `${d.name} nonce ${d.nonce}`).join(", "));
  s.ref("pending stranger nonces", `${st.a.nonce}, ${st.b.nonce}`);
}
