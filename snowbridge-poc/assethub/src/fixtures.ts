import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { u8aToHex } from "@polkadot/util";
import type { Address, Hex } from "viem";
import { connect } from "./chain.js";
import { ETHEREUM_CHAIN_ID, ROOT } from "./constants.js";
import { accountLocation, ethereumAccountLocation } from "./location.js";

const COMPACT_VALUES = [0n, 1n, 63n, 64n, 16383n, 16384n, 2n ** 30n - 1n, 2n ** 30n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 64n, 10n ** 18n, 2n ** 128n - 1n];

const TRANSFERS: { chainId: bigint; token: Address; amount: bigint; account: Hex }[] = [
  {
    chainId: ETHEREUM_CHAIN_ID,
    token: "0x54d6643762e46036b3448659791adaf554225541",
    amount: 1_000_000_000_000_000_000n,
    account: `0x${"11".repeat(32)}`,
  },
  {
    chainId: 1n,
    token: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    amount: 5n,
    account: `0x${"ff".repeat(32)}`,
  },
];

const api = await connect();
try {
  const compact = COMPACT_VALUES.map((value) => ({
    value: value.toString(),
    hex: u8aToHex(api.createType("Compact<u128>", value).toU8a()),
  }));
  const transfers = TRANSFERS.map(({ chainId, token, amount, account }) => ({
    chainId: chainId.toString(),
    token,
    amount: amount.toString(),
    account,
    message: u8aToHex(
      api
        .createType("XcmVersionedXcm", {
          V5: [
            {
              TransferAsset: {
                assets: [{ id: ethereumAccountLocation(chainId, token), fun: { Fungible: amount } }],
                beneficiary: accountLocation(account),
              },
            },
          ],
        })
        .toU8a(),
    ),
  }));
  const file = resolve(ROOT, "test/fixtures/xcm-transfer.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ compact, transfers }, null, 2)}\n`);
  console.log(`wrote ${file}`);
  const metadataFile = resolve(ROOT, "test/fixtures/asset-hub-metadata.scale.gz");
  writeFileSync(metadataFile, gzipSync(api.runtimeMetadata.toU8a()));
  console.log(`wrote ${metadataFile}`);
} finally {
  await api.disconnect();
}
