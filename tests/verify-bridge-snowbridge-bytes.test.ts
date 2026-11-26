// The bytes of the Snowbridge program from the metadata the repo ships, against the bytes the
// metadata of Polkadot Asset Hub gives for the same program. The test reads the live metadata once
// and sends nothing.
//   VERIFY_BRIDGE_ASSET_HUB=https://polkadot-asset-hub-rpc.polkadot.io pnpm vitest run tests/verify-bridge-snowbridge-bytes.test.ts

import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { getTypedCodecs } from "polkadot-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  encodeXcm,
  snowbridgeProgram,
  type SnowbridgeProgramInput,
  type XcmValue,
} from "@getsome/bridge";

const NODE = process.env.VERIFY_BRIDGE_ASSET_HUB;

const ACCOUNT = `0x${"42".repeat(32)}`;
const FEES = {
  account: ACCOUNT,
  hydrationFeeEther: 200_000_000_000_000n,
  assetHubFeeUsdt: 200_000n,
  assetHubFeeEther: 60_000_000_000_000n,
};

/** Three sizes of top-up, so the amounts take encodings of different lengths. */
const CASES: [string, SnowbridgeProgramInput][] = [
  ["0.01 ETH", { ...FEES, swapEther: 10_000_000_000_000_000n, minimumUsdt: 17_000_000n }],
  ["0.5 ETH", { ...FEES, swapEther: 500_000_000_000_000_000n, minimumUsdt: 850_000_000n }],
  ["10 ETH", { ...FEES, swapEther: 10_000_000_000_000_000_000n, minimumUsdt: 16_000_000_000n }],
];

/** The codec of a versioned XCM, as the bridge takes it from the repo's metadata. */
interface XcmCodec {
  enc(value: [XcmValue]): Uint8Array;
  dec(bytes: Uint8Array): [XcmValue];
}

async function ask(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(NODE!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const reply = (await response.json()) as { result?: unknown };
  if (reply.result === undefined) throw new Error(`the node gave no answer to ${method}`);
  return reply.result;
}

describe.runIf(NODE !== undefined && NODE !== "")("the Snowbridge program's bytes", () => {
  let live: XcmCodec;

  beforeAll(async () => {
    const version = (await ask("state_getRuntimeVersion", [])) as { specName: string };
    expect(version.specName).toBe("statemint");
    // Version 15 of the metadata, the first that lists the runtime calls.
    const metadata = (await ask("state_call", [
      "Metadata_metadata_at_version",
      "0x0f000000",
    ])) as string;
    const codecs = await getTypedCodecs({
      getMetadata: async () => hexToBytes(metadata.slice(2)),
    } as never);
    live = (codecs.apis as unknown as { XcmPaymentApi: { query_xcm_weight: { args: XcmCodec } } })
      .XcmPaymentApi.query_xcm_weight.args;
  }, 60_000);

  it.each(CASES)(
    "are the bytes Polkadot Asset Hub's metadata gives, for %s",
    async (_name, input) => {
      const program = snowbridgeProgram(input);
      expect(bytesToHex(await encodeXcm(program))).toBe(
        bytesToHex(live.enc([{ type: "V5", value: program }])),
      );
    },
  );

  it.each(CASES)("decode there as one whole version 5 program, for %s", async (_name, input) => {
    const bytes = await encodeXcm(snowbridgeProgram(input));
    // Bytes after the program show a decoder that reads past its end.
    const [decoded] = live.dec(concatBytes(bytes, new Uint8Array(32).fill(0xff)));
    expect(decoded.type).toBe("V5");
    expect(bytesToHex(live.enc([decoded]))).toBe(bytesToHex(bytes));
  });
});
