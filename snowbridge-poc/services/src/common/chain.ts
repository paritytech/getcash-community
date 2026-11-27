import { createPublicClient, defineChain, http, type Chain } from "viem";

// The target chain is only known by its RPC URL, so ask the node for the id.
export async function resolveChain(rpcUrl: string): Promise<Chain> {
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  return defineChain({
    id: chainId,
    name: "target",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
