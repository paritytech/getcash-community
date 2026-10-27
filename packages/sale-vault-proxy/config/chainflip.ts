// Checks a network config against the live Chainflip State Chain before it is trusted.

import { createHash } from "node:crypto";
import { concat, encodeBase58, getBytes } from "ethers";
import { CF_BLOCK_SECONDS, type SaleVaultProxyNetwork } from "./networks";

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (body.result === undefined) throw new Error(`${method}: no result`);
  return body.result;
}

// Chainflip's SS58 prefix, cf_account_info only takes SS58
const CHAINFLIP_SS58_PREFIX = 2112;

/** The SS58 form of a 32-byte account id under Chainflip's prefix. */
export function chainflipSs58(accountId: string): string {
  const p = CHAINFLIP_SS58_PREFIX;
  const body = concat([
    Uint8Array.of(((p & 0xfc) >> 2) | 0x40, (p >> 8) | ((p & 3) << 6)),
    accountId,
  ]);
  const sum = createHash("blake2b512")
    .update(Buffer.concat([Buffer.from("SS58PRE"), getBytes(body)]))
    .digest();
  return encodeBase58(concat([body, sum.subarray(0, 2)]));
}

// A SCALE u64 little-endian hex to a bigint
const leU64 = (hex: string): bigint =>
  BigInt("0x" + (hex.slice(2).match(/../g) ?? []).reverse().join(""));

const big = (v: unknown): bigint | null =>
  v === null || v === undefined ? null : BigInt(v as string);

/** The live limits a config must respect, read from the network's Chainflip RPC. */
export async function liveLimits(net: SaleVaultProxyNetwork) {
  const [vaults, ingress, swapping, slot, broker] = await Promise.all([
    rpc(net.chainflipRpc, "cf_get_vault_addresses"),
    rpc(net.chainflipRpc, "cf_ingress_egress_environment"),
    rpc(net.chainflipRpc, "cf_swapping_environment"),
    rpc(net.chainflipRpc, "state_call", ["AuraApi_slot_duration", "0x"]),
    rpc(net.chainflipRpc, "cf_account_info", [chainflipSs58(net.broker)]),
  ]);
  const networkFeeMinimum = BigInt(
    swapping.network_fees.regular_network_fee.standard_rate_and_minimum.minimum,
  );
  return {
    vault: "0x" + Buffer.from(vaults.arbitrum.Arb as number[]).toString("hex"),
    minDeposit: BigInt(ingress.minimum_deposit_amounts.Arbitrum.USDC),
    maxSwap: big(swapping.maximum_swap_amounts.Arbitrum.USDC),
    maxRetryBlocks: Number(swapping.max_swap_retry_duration_blocks),
    maxRequestBlocks: BigInt(swapping.max_swap_request_duration_blocks),
    blockMs: leU64(slot),
    brokerRole: String(broker.role),
    // A killed return costs the network fee minimum plus the Arbitrum USDC egress back here
    refundFee: networkFeeMinimum + BigInt(ingress.egress_fees.Arbitrum.USDC),
    // A return pays at least the network fee minimum plus the Asset Hub USDT egress
    returnFees: networkFeeMinimum + BigInt(ingress.egress_fees.Assethub.USDT),
  };
}

/** Every way a config falls short of the live limits, empty when it is safe to deploy. */
export async function liveProblems(net: SaleVaultProxyNetwork): Promise<string[]> {
  const live = await liveLimits(net);
  const problems: string[] = [];
  if (live.vault !== net.vault.toLowerCase()) problems.push(`vault is ${live.vault}`);
  if (net.minDeposit < live.minDeposit) problems.push(`minDeposit below ${live.minDeposit}`);
  if (net.refundFee < live.refundFee) problems.push(`refundFee below ${live.refundFee}`);
  if (net.feeAllowance < live.returnFees) problems.push(`feeAllowance below ${live.returnFees}`);
  if (live.maxSwap !== null && net.maxReturn > live.maxSwap)
    problems.push(`maxReturn above ${live.maxSwap}`);
  if (net.retryBlocks > live.maxRetryBlocks)
    problems.push(`retryBlocks above ${live.maxRetryBlocks}`);
  if (live.blockMs !== CF_BLOCK_SECONDS * 1000n) problems.push(`block time is ${live.blockMs} ms`);
  if (live.brokerRole !== "broker") problems.push(`broker is ${live.brokerRole}`);
  if (net.releaseDelay < live.maxRequestBlocks * CF_BLOCK_SECONDS)
    problems.push(`releaseDelay below ${live.maxRequestBlocks * CF_BLOCK_SECONDS}`);
  return problems;
}
