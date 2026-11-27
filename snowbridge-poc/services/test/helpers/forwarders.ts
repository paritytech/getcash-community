import { parseEventLogs, type Address, type Hex } from "viem";
import { factoryAbi, forwarderAbi } from "../../src/common/abi";
import { EXECUTION_FEE, mintTo, type Stack, type Wallet } from "./stack";

// A forwarder anyone can open, with whichever owner they like; its owner may trigger it without the registry's key.
export async function deployForwarderAs(stack: Stack, caller: Wallet, account: Hex, owner: Address): Promise<Address> {
  const hash = await stack.clientFor(caller).writeContract({ address: stack.factory, abi: factoryAbi, functionName: "deploy", args: [account, owner] });
  const receipt = await stack.publicClient.waitForTransactionReceipt({ hash });
  const [deployed] = parseEventLogs({ abi: factoryAbi, eventName: "ForwarderDeployed", logs: receipt.logs });
  return deployed!.args.forwarder;
}

export async function fundedForwarder(stack: Stack, caller: Wallet, owner: Address, label: string, amount: bigint): Promise<Address> {
  const forwarder = await deployForwarderAs(stack, caller, `0x${Buffer.from(label.padEnd(32, "-")).toString("hex")}`, owner);
  await mintTo(stack, stack.token, forwarder, amount);
  return forwarder;
}

// `gas` is given so the call can be sent into a block that is not mined yet, where the state it needs does not exist when it is estimated.
export function sendTrigger(stack: Stack, caller: Wallet, forwarder: Address, options: { wait?: boolean } = {}): Promise<Hex> {
  const send = async () => {
    const hash = await stack.clientFor(caller).writeContract({
      address: forwarder,
      abi: forwarderAbi,
      functionName: "trigger",
      args: [stack.token, EXECUTION_FEE, 0n],
      value: EXECUTION_FEE,
      gas: 2_000_000n,
    });
    if (options.wait !== false) await stack.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };
  return send();
}
