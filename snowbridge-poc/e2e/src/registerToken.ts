import "./quietPolkadot";
import { parseAbi } from "viem";
import { connect } from "../../assethub/src/chain";
import { ETHEREUM_CHAIN_ID } from "../../assethub/src/constants";
import { deployerClient, snowbridgeContracts } from "../../assethub/src/ethereum";
import { ethereumAccountLocation } from "../../assethub/src/location";
import { publicClient, waitFor } from "./chains";
import { ASSET_HUB_WS } from "./config";

const gatewayAbi = parseAbi([
  "function isTokenRegistered(address token) view returns (bool)",
  "function v2_registerToken(address token, uint8 network, uint128 executionFee, uint128 relayerFee) payable",
]);

const EXECUTION_FEE = 1_500_000_000_000n;
const RELAYER_FEE = 1_500_000_000_000n;
const VALUE = 13_000_000_000_000n;
const POLKADOT_NETWORK = 0;
const CREATION_TIMEOUT_MS = 10 * 60_000;

// Registers the TEST token on the Gateway and waits for the stock relayer to create it on Asset Hub; a stack restart wipes both.
async function main(): Promise<void> {
  const { gateway, token } = snowbridgeContracts();
  const { wallet } = deployerClient();
  const registered = await publicClient.readContract({ address: gateway, abi: gatewayAbi, functionName: "isTokenRegistered", args: [token] });
  if (registered) console.log(`  ${token} is already registered on the Gateway`);
  else {
    const hash = await wallet.writeContract({ address: gateway, abi: gatewayAbi, functionName: "v2_registerToken", args: [token, POLKADOT_NETWORK, EXECUTION_FEE, RELAYER_FEE], value: VALUE });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("v2_registerToken reverted");
    console.log(`  registered ${token}: tx ${hash}, block ${receipt.blockNumber}`);
  }

  const api = await connect(ASSET_HUB_WS);
  try {
    const location = ethereumAccountLocation(ETHEREUM_CHAIN_ID, token);
    const started = Date.now();
    await waitFor("the TEST foreign asset on Asset Hub", async () => ((await api.query.foreignAssets.asset(location)) as unknown as { isSome: boolean }).isSome, CREATION_TIMEOUT_MS, 5_000);
    console.log(`  the foreign asset exists on Asset Hub (${Math.round((Date.now() - started) / 1000)} s)`);
  } finally {
    await api.disconnect();
  }
}

await main();
