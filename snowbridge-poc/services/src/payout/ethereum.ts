import { createPublicClient, getAbiItem, getAddress, http, type Address } from "viem";
import { factoryAbi, registryAbi, routerAbi } from "../common/abi";
import { routerSentAbi } from "./abi";
import type { EthereumClient } from "./types";

const RELAYER_CHANGED = getAbiItem({ abi: registryAbi, name: "RelayerChanged" });

export function viemEthereumClient(rpcUrl: string, router: Address): EthereumClient {
  const client = createPublicClient({ transport: http(rpcUrl) });
  let registry: Address | undefined;

  const registryAddress = async (): Promise<Address> => {
    if (registry) return registry;
    const factory = await client.readContract({ address: router, abi: routerAbi, functionName: "FACTORY" });
    registry = await client.readContract({ address: factory, abi: factoryAbi, functionName: "REGISTRY" });
    return registry;
  };

  return {
    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async finalizedBlock() {
      const block = await client.getBlock({ blockTag: "finalized" });
      return block.number;
    },
    async sentEvents(fromBlock, toBlock) {
      const logs = await client.getLogs({ address: router, event: routerSentAbi[0], fromBlock, toBlock, strict: true });
      return logs.map(({ args, blockNumber, transactionHash }) => ({
        depositId: args.depositId,
        account: args.account,
        token: args.token,
        amount: args.amount,
        blockNumber,
        txHash: transactionHash,
      }));
    },
    // Same rule as the relayer's `isOurs`: the key that was relayer before the transaction, with rotations in the same block applied by transaction index.
    async triggerAuthority({ txHash, blockNumber }) {
      const tx = await client.getTransaction({ hash: txHash });
      if (tx.blockNumber !== blockNumber || tx.blockHash === null || tx.transactionIndex === null) {
        throw new Error(`transaction ${txHash} is not in block ${blockNumber}`);
      }
      const registryContract = await registryAddress();
      const before = await client.readContract({ address: registryContract, abi: registryAbi, functionName: "relayer", blockNumber: blockNumber - 1n });
      const rotations = await client.getLogs({ address: registryContract, event: RELAYER_CHANGED, blockHash: tx.blockHash, strict: true });
      const applied = rotations
        .filter((rotation) => rotation.transactionIndex < tx.transactionIndex!)
        .sort((a, b) => a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
      const relayer = applied.length > 0 ? applied[applied.length - 1]!.args.relayer : before;
      return { signer: getAddress(tx.from), relayer: getAddress(relayer) };
    },
  };
}
