// Hosted seams of a withdrawal: the disposable key the purse pays, the purse's payment to it, the
// key's CASH on People, and the hand-off to the worker. The chain legs run in the product's
// worker, and so does the payment call, since the worker is the host's payment client for the
// top-up claims already; this page hands the request over and reads it back, as coinage-live
// does for the on-ramp.

import { deriveEntropy, getHostLocalStorage } from "@parity/product-sdk-host";
import { deriveKeypair } from "@getsome/ephemeral";
import { PASEO_ASSET_HUB_PARA_ID, PASEO_PEOPLE_PARA_ID } from "@getsome/funding";
import {
  createHostEntropyPort,
  createHostStorageAdapter,
  type HostLocalStorageLike,
} from "@getsome/host";
import { CASH_LOCATION } from "@getsome/people";
import {
  CASH_ON_ASSET_HUB,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  PASEO_PEOPLE_POOL_ACCOUNT,
  PEOPLE_NATIVE,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  WITHDRAW_SOURCE_PREFIX,
  isWithdrawSourceId,
  type HostPaymentStatus,
  type WithdrawalHandoffPayload,
} from "../app/funding/requests/model";
import { hostSafeEntropy, nextFreeTradeNumber, readTradeCounter, tradeCounterKey } from "./coinage";
import { ASSET_HUB_GENESIS, PEOPLE_GENESIS } from "./host-chain";

/** How long to wait for the worker to come up before a hand-off fails. */
const WORKER_READY_MS = 20_000;
/** Bound on the worker's answer to a payment status read: its own host read is bounded under it. */
const PAYMENT_STATUS_DEADLINE_MS = 15_000;

const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The entropy label of withdrawal `n` under `sourceId`, at most 32 bytes, the host's key limit.
 *  The worker builds the same bytes from the string it is handed. */
export function withdrawEntropyLabel(sourceId: string, n: number): string {
  if (!isWithdrawSourceId(sourceId)) throw new Error(`'${sourceId}' is not a withdrawal source`);
  return `wd:eph:${sourceId.slice(WITHDRAW_SOURCE_PREFIX.length)}:${n}`;
}

export interface WithdrawKey {
  /** The key's People address. */
  address: string;
  publicKeyHex: `0x${string}`;
}

/** Withdrawal `n`'s key, derived from the host's entropy root. */
export async function withdrawKeyFor(sourceId: string, n: number): Promise<WithdrawKey> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  const seed = await entropy.deriveSeed(
    new TextEncoder().encode(withdrawEntropyLabel(sourceId, n)),
  );
  const keypair = deriveKeypair(seed);
  return { address: keypair.address, publicKeyHex: toHex(keypair.publicKey) };
}

/** The key's CASH on People at the best block. */
export async function probeWithdrawKey(
  sourceId: string,
  n: number,
): Promise<{ address: string; cash: bigint }> {
  const { address } = await withdrawKeyFor(sourceId, n);
  const { connectChain, PEOPLE } = await import("./host-chain");
  const api = (await connectChain(PEOPLE)).getTypedApi(paseo_people_next);
  const account = await api.query.Assets.Account.getValue(CASH_LOCATION as never, address, {
    at: "best",
  });
  return { address, cash: account?.balance ?? 0n };
}

/** The CASH the fees take from a direct withdrawal before the sale on Asset Hub, as measured on
 *  Paseo: the People swap for the fee PAS, about 0.42 CASH, and Asset Hub's execution fee. */
const DIRECT_FEES_CASH = 450_000n;

/** What a direct withdrawal of `amount` CASH lands on Asset Hub, in planck, at today's pool
 *  price: the amount less the fees, sold as the program sells it. An estimate for the summary,
 *  not what the program is held to. */
export async function quoteDirectReceive(amount: bigint): Promise<bigint> {
  const sold = amount - DIRECT_FEES_CASH;
  if (sold <= 0n) return 0n;
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const quoted = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
    CASH_ON_ASSET_HUB as never,
    PEOPLE_NATIVE as never,
    sold,
    true,
  );
  if (quoted === undefined) throw new Error("Asset Hub cannot quote the sale");
  return quoted;
}

async function hostStorageAdapter() {
  const storage = await getHostLocalStorage();
  if (!storage) throw new Error("host storage unavailable (not running inside the Polkadot App?)");
  return createHostStorageAdapter(storage as HostLocalStorageLike);
}

/** The source's counter in the host store: the number the next withdrawal takes. */
export async function readWithdrawCounter(sourceId: string): Promise<number> {
  return readTradeCounter(await hostStorageAdapter(), sourceId);
}

/** The number the next withdrawal under `sourceId` takes: the counter, moved past every number
 *  `hasTrace` still knows of. */
export async function nextWithdrawNumber(
  sourceId: string,
  hasTrace: (n: number) => Promise<boolean>,
): Promise<number> {
  return nextFreeTradeNumber(await hostStorageAdapter(), sourceId, hasTrace);
}

/** Claims number `n` for good: the next withdrawal under `sourceId` derives a fresh key. A
 *  failed write is warned about; the next start searches past the taken number anyway. */
export async function advanceWithdrawCounter(sourceId: string, n: number): Promise<void> {
  try {
    await (await hostStorageAdapter()).write(tradeCounterKey(sourceId), String(n + 1));
  } catch (e) {
    console.warn(
      `[withdraw] counter advance for ${sourceId} failed (the next start searches past it):`,
      e,
    );
  }
}

/** The hand-off for a withdrawal, with the chain facts this build is made for. */
export function withdrawHandoff(args: {
  sourceId: string;
  n: number;
  key: WithdrawKey;
  amount: bigint;
  destination: WithdrawalHandoffPayload["destination"];
  landingHex: string;
  rail: WithdrawalHandoffPayload["rail"];
  paymentExpiresAt: number;
}): WithdrawalHandoffPayload {
  return {
    label: withdrawEntropyLabel(args.sourceId, args.n),
    keyAddress: args.key.address,
    keyPublicKeyHex: args.key.publicKeyHex,
    amount: args.amount.toString(),
    destination: args.destination,
    landingHex: args.landingHex,
    rail: args.rail,
    assetHubGenesis: ASSET_HUB_GENESIS,
    peopleGenesis: PEOPLE_GENESIS,
    peopleParaId: PASEO_PEOPLE_PARA_ID,
    assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
    poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
    slippagePct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
    paymentExpiresAt: args.paymentExpiresAt,
  };
}

interface WorkerLike {
  isAvailable(): boolean;
  call<T>(apiName: string, payload?: unknown, options?: { deadlineMs?: number }): Promise<T>;
}

/** Waits for the worker's heartbeat up to `WORKER_READY_MS`; throws when it never comes. */
async function awaitWorker(worker: WorkerLike, what: string): Promise<void> {
  const readyBy = Date.now() + WORKER_READY_MS;
  while (!worker.isAvailable() && Date.now() < readyBy) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!worker.isAvailable()) {
    throw new Error(`the funding worker is not running on this host; ${what}`);
  }
}

/** Hands one withdrawal to the worker: waits for its heartbeat, then sends `startWithdraw`.
 *  Idempotent on the session id; a refusal throws and no job exists. */
export async function sendWithdrawHandoff(
  worker: WorkerLike,
  sessionId: string,
  payload: WithdrawalHandoffPayload,
): Promise<void> {
  await awaitWorker(worker, "the withdrawal cannot start");
  await worker.call("startWithdraw", { sessionId, ...payload });
}

/** Tells the worker a withdrawal still waiting for its payment was cancelled. */
export function cancelWithdrawJob(worker: WorkerLike, sessionId: string): Promise<unknown> {
  return worker.call("cancelWithdraw", { sessionId });
}

/** Nudges the worker into a pass over its withdrawals. A run has stalled between wakes while the
 *  page was up, so each poll round drives a pass, as the top-up's loop does. Detached: a tick can
 *  take tens of seconds and the poll does not wait on it. A worker that is not up is left alone. */
export function nudgeWithdrawTicks(worker: WorkerLike): void {
  if (!worker.isAvailable()) return;
  void worker.call("tickAllWithdraw").catch(() => {});
}

/** The host's answer to a payment request, as the worker keeps it: the sheet is up, the host
 *  registered the payment, or the host refused it. */
export type PaymentPrompt = "prompting" | "registered" | "refused";

/** Has the worker ask the host to pay `amount` CASH to the key under `idHex`. Returns at once
 *  with the attempt's state: the host's sheet outlives the call, and its answer is read back with
 *  the status. Idempotent on the id: a repeated command raises no second sheet. */
export async function requestKeyPayment(
  worker: WorkerLike,
  args: { sessionId: string; idHex: string; amount: bigint; key: WithdrawKey },
): Promise<{ prompt: PaymentPrompt; reason?: string }> {
  await awaitWorker(worker, "the payment cannot be requested");
  return worker.call<{ prompt: PaymentPrompt; reason?: string }>("requestPayment", {
    sessionId: args.sessionId,
    idHex: args.idHex,
    amount: args.amount.toString(),
    destinationHex: args.key.publicKeyHex,
  });
}

export interface PaymentStatusReading {
  status: HostPaymentStatus;
  reason?: string;
  /** Base units, when the host paid short. */
  actualClaimed?: string;
}

const HOST_STATUSES: readonly HostPaymentStatus[] = [
  "processing",
  "completed",
  "failed",
  "partiallyClaimed",
];

/** What the worker answers a status read with. */
interface WorkerPaymentStatus {
  prompt: PaymentPrompt | "unknown";
  reason?: string;
  /** The host's status; null while the host knows nothing of the id; absent when the read failed. */
  host?: { type: string; reason?: string; actualClaimed?: string } | null;
  hostError?: string;
}

/** One read of the host's word on payment `idHex`, through the worker. The host's status when it
 *  has one; a refused prompt reads as a failed payment with the host's reason; an id the host
 *  does not know yet reads as `not-found`. Throws when the host could not be asked. */
export async function readPaymentStatus(
  worker: WorkerLike,
  idHex: string,
): Promise<PaymentStatusReading> {
  const answer = await worker.call<WorkerPaymentStatus>(
    "paymentStatus",
    { idHex },
    { deadlineMs: PAYMENT_STATUS_DEADLINE_MS },
  );
  const { host } = answer;
  if (host !== null && host !== undefined) {
    const status = HOST_STATUSES.find((known) => known === host.type);
    if (status === undefined) throw new Error(`unknown payment status '${host.type}'`);
    return {
      status,
      ...(host.reason === undefined ? {} : { reason: host.reason }),
      ...(host.actualClaimed === undefined ? {} : { actualClaimed: host.actualClaimed }),
    };
  }
  if (host === undefined) {
    throw new Error(answer.hostError ?? "the host could not be asked about the payment");
  }
  if (answer.prompt === "refused") {
    return {
      status: "failed",
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    };
  }
  return { status: "not-found" };
}
