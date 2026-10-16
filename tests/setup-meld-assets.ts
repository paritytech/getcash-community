// Installs Meld's asset codes as a booted page would after reading the adapter's `GET /assets`, so
// a test that never boots the page still names assets under the codes Meld uses today. A test that
// resets modules gets a fresh, empty table and installs this one again (`installTestMeldAssets`).
import { installMeldAssets, type MeldAsset } from "@getsome/core";

export const TEST_MELD_ASSETS: readonly MeldAsset[] = [
  { asset: "dot@assethub", code: "DOT" },
  { asset: "usdt@assethub", code: "USDT_DOT" },
  { asset: "usdc@assethub", code: "USDC_DOT" },
  { asset: "usdt@solana", code: "USDT_SOLANA" },
  { asset: "usdc@solana", code: "USDC_SOLANA" },
  { asset: "usdc@arbitrum", code: "USDC_ARBITRUM" },
];

/** Installs the test table into whichever `@getsome/core` the module registry now holds. */
export async function installTestMeldAssets(): Promise<void> {
  (await import("@getsome/core")).installMeldAssets(TEST_MELD_ASSETS);
}

installMeldAssets(TEST_MELD_ASSETS);
