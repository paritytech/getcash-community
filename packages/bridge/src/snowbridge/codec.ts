// The SCALE bytes of an XCM program, to and from its instruction list. The codecs come from the
// metadata the repo ships, so no chain is read. That metadata is of a test network. Version 5 of
// XCM has one format on every chain, and a live test holds these bytes against the ones the
// metadata of Polkadot Asset Hub gives.

import { concatBytes } from "@noble/hashes/utils.js";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import { getTypedCodecs } from "polkadot-api";

/** A value as the chain codecs take it: the name of a variant and its content. */
export interface XcmValue {
  type: string;
  value?: unknown;
}

/** One instruction of a program. */
export type XcmInstruction = XcmValue;

let codecs: ReturnType<typeof getTypedCodecs<typeof paseo_next_v2>> | null = null;

/** The codec of a versioned XCM: the one argument of the runtime call that weighs a program. */
const versionedXcm = async () =>
  (await (codecs ??= getTypedCodecs(paseo_next_v2))).apis.XcmPaymentApi.query_xcm_weight.args;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** The bytes of `program` as a version 5 XCM. */
export async function encodeXcm(program: XcmInstruction[]): Promise<Uint8Array> {
  const codec = await versionedXcm();
  return codec.enc([{ type: "V5", value: program }] as never);
}

/** Bytes put after a program before it is decoded. A whole program never reads them. */
const PAST_THE_END = new Uint8Array(32).fill(0xff);

/** The program in `bytes`, which must hold one whole version 5 XCM and nothing else. */
export async function decodeXcm(bytes: Uint8Array): Promise<XcmInstruction[]> {
  const codec = await versionedXcm();
  // The decoder does not say where it stopped: it ignores what follows a program, and it reads a
  // program cut short as far as the bytes go. So the program is decoded with other bytes after
  // it, and it must encode back to exactly the bytes given.
  const [xcm] = codec.dec(concatBytes(bytes, PAST_THE_END)) as unknown as [XcmValue];
  if (!sameBytes(codec.enc([xcm] as never), bytes)) {
    throw new Error("the bytes are not one whole XCM program");
  }
  if (xcm.type !== "V5") throw new Error(`the XCM is ${xcm.type}, not V5`);
  return xcm.value as XcmInstruction[];
}
