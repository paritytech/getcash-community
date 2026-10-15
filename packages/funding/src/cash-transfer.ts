// Which transfer moves CASH between Asset Hub and People on the connected network, read from the
// XCM trust each runtime enforces through TrustedQueryApi. Both chains are asked through papi's
// unsafe API: People's generated descriptors list the API on some networks and not others, and
// the unsafe API reads the live metadata instead.

import { TOKENS, type XcmLocation } from "@getsome/core";
import type { PolkadotClient } from "polkadot-api";
import { siblingOrigin } from "./xcm-dry-run";

export type CashTransfer = "teleport" | "reserve";

/** Neither chain trusts a teleport of CASH, and People does not take Asset Hub as its reserve. */
export class NoCashTransferError extends Error {
  constructor() {
    super("this network does not let CASH move between Asset Hub and People");
    this.name = "NoCashTransferError";
  }
}

// Substrate lists a runtime API in `System.Version.apis` by the 8-byte blake2b hash of its name.
const TRUSTED_QUERY_API_ID = "0x2609be83ac4468dc";

type TrustQuery = (asset: unknown, location: unknown) => Promise<unknown>;

// The unsafe API is a proxy: every entry exists as a function and the call fails when the runtime
// lacks it, so presence is read from System.Version rather than from the entry.
type ChainApi = {
  constants: { System: { Version: () => Promise<unknown> } };
  apis: { TrustedQueryApi: { is_trusted_teleporter: TrustQuery; is_trusted_reserve: TrustQuery } };
};

const chainApi = (client: PolkadotClient) => client.getUnsafeApi() as unknown as ChainApi;

/** Asset Hub must answer. Teleport when Asset Hub trusts it and People agrees or cannot answer;
 *  reserve otherwise when People trusts Asset Hub as CASH's reserve or cannot answer. */
export async function chooseCashTransfer(args: {
  assetHub: PolkadotClient;
  people: PolkadotClient;
  assetHubParaId: number;
  peopleParaId: number;
}): Promise<CashTransfer> {
  const assetHub = chainApi(args.assetHub);
  const people = chainApi(args.people);
  if (!(await listsTrustedQueryApi(assetHub))) {
    throw new Error("Asset Hub's runtime does not implement TrustedQueryApi");
  }
  const peopleAnswers = await listsTrustedQueryApi(people);

  const cashOnAssetHub = someCash(TOKENS.CASH.location);
  const cashOnPeople = someCash(TOKENS.CASH.locationOnPeople);
  const peopleLocation = siblingOrigin(args.peopleParaId);
  const assetHubLocation = siblingOrigin(args.assetHubParaId);

  const peopleTrusts = async (ask: () => Promise<unknown>) =>
    !peopleAnswers || answerOf(await ask());
  const trustedQuery = people.apis.TrustedQueryApi;

  const assetHubTeleports = answerOf(
    await assetHub.apis.TrustedQueryApi.is_trusted_teleporter(cashOnAssetHub, peopleLocation),
  );
  if (
    assetHubTeleports &&
    (await peopleTrusts(() => trustedQuery.is_trusted_teleporter(cashOnPeople, assetHubLocation)))
  ) {
    return "teleport";
  }
  if (await peopleTrusts(() => trustedQuery.is_trusted_reserve(cashOnPeople, assetHubLocation))) {
    return "reserve";
  }
  throw new NoCashTransferError();
}

async function listsTrustedQueryApi(api: ChainApi): Promise<boolean> {
  const version: unknown = await api.constants.System.Version();
  const apis = (version as { apis?: unknown }).apis;
  if (!Array.isArray(apis)) throw new Error("System.Version lists no runtime apis");
  return apis.some((entry: unknown) => Array.isArray(entry) && entry[0] === TRUSTED_QUERY_API_ID);
}

// Trust does not depend on the amount, so any positive fungible amount asks the same question.
const someCash = (location: XcmLocation) => ({
  type: "V5",
  value: { id: location, fun: { type: "Fungible", value: 1n } },
});

function answerOf(result: unknown): boolean {
  const answer = result as { success?: unknown; value?: unknown };
  if (answer.success === true && typeof answer.value === "boolean") return answer.value;
  const kind = (answer.value as { type?: unknown } | undefined)?.type;
  throw new Error(`TrustedQueryApi failed: ${typeof kind === "string" ? kind : "unknown error"}`);
}
