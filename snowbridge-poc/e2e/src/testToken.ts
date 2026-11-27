import { bytesToHex, encodeAbiParameters, getAddress, parseAbi, type Address, type Hex } from "viem";
import { devKeyring } from "../../assethub/src/chain";
import { ETHEREUM_CHAIN_ID } from "../../assethub/src/constants";
import { deployerClient, snowbridgeContracts } from "../../assethub/src/ethereum";
import { quoteDelivery } from "../../assethub/src/fees";
import { accountLocation, ethereumAccountLocation } from "../../assethub/src/location";
import { signedOriginNetwork } from "../../assethub/src/network";
import { foreignBalance } from "../../assethub/src/revive";
import { depositAll, encodeVersionedXcm } from "../../assethub/src/xcm";
import { publicClient, tokenAbi, waitFor } from "./chains";
import { signWithRetry, type Api } from "./substrate";

const gatewayAbi = parseAbi(["function v2_sendMessage(bytes xcm, bytes[] assets, bytes claimer, uint128 executionFee, uint128 relayerFee) payable"]);

const ONE_TOKEN = 10n ** 18n;
const ALICE_TOPUP = 1_000n * ONE_TOKEN;
const BRIDGE_TIMEOUT_MS = 8 * 60_000;

// Mints on Ethereum (the deployer is Token.gateway()) and bridges with a plain DepositAsset, as the first TEST on Asset Hub was.
async function bridgeToAlice(api: Api, token: Address, amount: bigint): Promise<void> {
  const { gateway } = snowbridgeContracts();
  const { account, wallet } = deployerClient();
  const alice = devKeyring("//Alice");
  const aliceAccount = bytesToHex(alice.publicKey);
  const send = async (request: { functionName: string } & Record<string, unknown>) => {
    const hash = await wallet.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${request.functionName} reverted`);
    console.log(`  ${request.functionName} ${hash}`);
  };

  const claimer = api.createType("StagingXcmV5Location", accountLocation(aliceAccount, await signedOriginNetwork(api))).toHex();
  const xcm = encodeVersionedXcm(api, [depositAll(aliceAccount)]);
  const quote = await quoteDelivery(api, { router: account.address, nonce: 0n, xcm, claimer, value: 0n, executionFee: 1n, assets: [{ token, amount }] });
  const executionFee = (quote.fee * 15n) / 10n;
  const before = await foreignBalance(api, token, alice.address);

  await send({ address: token, abi: tokenAbi, functionName: "mint", args: [account.address, amount] });
  await send({ address: token, abi: tokenAbi, functionName: "approve", args: [gateway, amount] });
  const asset = encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint128" }], [0, token, amount]);
  await send({ address: gateway, abi: gatewayAbi, functionName: "v2_sendMessage", args: [xcm, [asset], claimer, executionFee, 0n], value: executionFee });

  console.log("  waiting for the stock relayer to deliver the TEST to //Alice (about two minutes)");
  await waitFor("TEST to reach //Alice", async () => (await foreignBalance(api, token, alice.address)) >= before + amount, BRIDGE_TIMEOUT_MS, 5_000);
}

// Gives `to` this much TEST on Asset Hub, from //Alice's bridged balance; tops //Alice up through the bridge when she holds too little.
export async function fundTestOnAssetHub(api: Api, token: Address, to: string, amount: bigint, forceBridge = false): Promise<void> {
  const alice = devKeyring("//Alice");
  const held = await foreignBalance(api, token, alice.address);
  if (forceBridge || held < amount) {
    console.log(`//Alice holds ${held} TEST; bridging ${forceBridge ? amount : ALICE_TOPUP + amount} more`);
    await bridgeToAlice(api, token, forceBridge ? amount : ALICE_TOPUP + amount);
  }
  const location = ethereumAccountLocation(ETHEREUM_CHAIN_ID, getAddress(token));
  await signWithRetry(api, () => api.tx.foreignAssets.transfer(location, to, amount), alice);
}

export async function mintTest(token: Address, to: Address, amount: bigint): Promise<Hex> {
  const { wallet } = deployerClient();
  const hash = await wallet.writeContract({ address: token, abi: tokenAbi, functionName: "mint", args: [to, amount] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
