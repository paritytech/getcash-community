import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

export type WithdrawRequest = {
  chainId: number;
  forwarder: Address;
  // `address(0)` withdraws ether.
  token: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

export function withdrawTypedData(request: WithdrawRequest) {
  return {
    domain: { name: "Forwarder", version: "1", chainId: request.chainId, verifyingContract: request.forwarder },
    types: {
      Withdraw: [
        { name: "token", type: "address" },
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Withdraw",
    message: {
      token: request.token,
      to: request.to,
      amount: request.amount,
      nonce: request.nonce,
      deadline: request.deadline,
    },
  } as const;
}

// Matches `Forwarder.withdrawDigest`; anyone may submit the result to `Forwarder.withdraw`.
export function signWithdraw(owner: LocalAccount, request: WithdrawRequest): Promise<Hex> {
  return owner.signTypedData(withdrawTypedData(request));
}
