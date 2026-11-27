import { parseArgs } from "node:util";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { loadForwarderCreationCode } from "../common/artifacts";
import { connect, readWithdrawNonce, sendTokens, submitWithdraw } from "./chain";
import { deriveUser } from "./derive";
import { loadUserEnv } from "./env";
import { predictDepositAddress } from "./depositAddress";
import { getDeposits, registerDeposit } from "./triggerApi";
import { signWithdraw } from "./withdraw";

const USAGE = `usage: user <command> [options]

commands:
  address    print the owner address, Asset Hub account and deposit address
  register   register the deposit address with the trigger service
  status     show the deposits the trigger service recorded
  send       send --amount (base units) of --token from the owner key to the deposit address
  withdraw   sign an owner withdraw of --token (default: ether) to --to; --submit sends it with the owner key

options (env fallback): --seed (USER_SEED), --factory (FACTORY_ADDRESS), --rpc (RPC_URL),
  --trigger-url (TRIGGER_URL, default http://127.0.0.1:8787), --token, --to, --amount, --deadline-secs (default 3600)
env file: USER_ENV_FILE, default .env.user (then .env); only the variables above are read from it`;

async function main(): Promise<void> {
  loadUserEnv();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      seed: { type: "string" },
      factory: { type: "string" },
      rpc: { type: "string" },
      "trigger-url": { type: "string" },
      token: { type: "string" },
      to: { type: "string" },
      amount: { type: "string" },
      "deadline-secs": { type: "string" },
      submit: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (!command) return void console.log(USAGE);

  const user = deriveUser(required(values.seed ?? process.env.USER_SEED, "--seed or USER_SEED"));
  const factory = address(values.factory ?? process.env.FACTORY_ADDRESS, "--factory or FACTORY_ADDRESS");
  const deposit = predictDepositAddress({
    factory,
    account: user.assetHubAccount,
    owner: user.owner.address,
    creationCode: loadForwarderCreationCode(),
  });
  const triggerUrl = values["trigger-url"] ?? process.env.TRIGGER_URL ?? "http://127.0.0.1:8787";

  switch (command) {
    case "address":
      return print({
        owner: user.owner.address,
        assetHubAccount: user.assetHubAccount,
        assetHubAddress: user.assetHubAddress,
        depositAddress: deposit,
      });
    case "register": {
      const { created } = await registerDeposit(triggerUrl, { account: user.assetHubAccount, owner: user.owner.address, address: deposit });
      return print({ depositAddress: deposit, created });
    }
    case "status":
      return print(await getDeposits(triggerUrl, deposit));
    case "send": {
      const chain = await connect(required(values.rpc ?? process.env.RPC_URL, "--rpc or RPC_URL"), user.owner);
      const token = address(values.token, "--token");
      const txHash = await sendTokens(chain, token, deposit, BigInt(required(values.amount, "--amount")));
      return print({ txHash, to: deposit });
    }
    case "withdraw": {
      const chain = await connect(required(values.rpc ?? process.env.RPC_URL, "--rpc or RPC_URL"), user.owner);
      const request = {
        chainId: chain.chainId,
        forwarder: deposit,
        token: values.token ? address(values.token, "--token") : zeroAddress,
        to: address(values.to, "--to"),
        amount: BigInt(required(values.amount, "--amount")),
        nonce: await readWithdrawNonce(chain, deposit),
        deadline: BigInt(Math.floor(Date.now() / 1000) + Number(values["deadline-secs"] ?? 3600)),
      };
      const signature = await signWithdraw(user.owner, request);
      const signed = { token: request.token, to: request.to, amount: request.amount, deadline: request.deadline, signature };
      if (values.submit) return print({ txHash: await submitWithdraw(chain, deposit, signed) });
      return print({ forwarder: deposit, ...signed });
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function address(value: string | undefined, name: string): Address {
  const text = required(value, name);
  if (!isAddress(text)) throw new Error(`${name} is not an address`);
  return getAddress(text);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
