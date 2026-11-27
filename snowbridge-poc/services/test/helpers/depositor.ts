import type { Address } from "viem";
import { loadForwarderCreationCode } from "../../src/common/artifacts";
import { connect, deriveUser, predictDepositAddress, registerDeposit, sendTokens } from "../../src/user";
import { mintTo, type Stack } from "./stack";

const creationCode = loadForwarderCreationCode();

// A user stand-in with its deposit address computed locally, as the phone does.
export function newDepositor(stack: Stack, seed: string) {
  const user = deriveUser(seed);
  const deposit = predictDepositAddress({
    factory: stack.factory,
    account: user.assetHubAccount,
    owner: user.owner.address,
    creationCode,
  });
  return {
    user,
    deposit,
    register: (baseUrl: string) =>
      registerDeposit(baseUrl, { account: user.assetHubAccount, owner: user.owner.address, address: deposit }),
    // The owner key sends the tokens, so it needs some of them and gas.
    send: async (token: Address, amount: bigint) => {
      await mintTo(stack, token, user.owner.address, amount);
      await stack.testClient.setBalance({ address: user.owner.address, value: 10n ** 18n });
      return sendTokens(await connect(stack.rpcUrl, user.owner), token, deposit, amount);
    },
  };
}
