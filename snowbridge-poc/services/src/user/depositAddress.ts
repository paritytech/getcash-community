import { concat, encodeAbiParameters, getCreate2Address, keccak256, type Address, type Hex } from "viem";

const PAIR = [{ type: "bytes32" }, { type: "address" }] as const;

export type DepositAddressInput = {
  factory: Address;
  account: Hex;
  owner: Address;
  // `Forwarder` creation bytecode, without constructor arguments.
  creationCode: Hex;
};

// The same CREATE2 math as `ForwarderFactory.predict`: salt = keccak256(abi.encode(account, owner)).
export function predictDepositAddress({ factory, account, owner, creationCode }: DepositAddressInput): Address {
  const args = encodeAbiParameters(PAIR, [account, owner]);
  return getCreate2Address({ from: factory, salt: keccak256(args), bytecodeHash: keccak256(concat([creationCode, args])) });
}
