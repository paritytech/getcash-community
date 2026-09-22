// Hosted seams of a withdrawal: the disposable key the purse pays, the purse's payment to it, the
// key's CASH on People, and the hand-off to the worker. The chain legs run in the product's
// worker, and so does the payment call, since the worker is the host's payment client for the
// top-up claims already; this page hands the request over and reads it back, as coinage-live
// does for the on-ramp.

import { PaymentRequestErr, PaymentStatusErr } from "@novasamatech/host-api";
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
  ASSET_HUB_POOL_FEE_PPM,
  assetHubAddressFor,
  assetHubPaymentOverhead,
  CASH_ON_ASSET_HUB,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  PASEO_PEOPLE_POOL_ACCOUNT,
  PEOPLE_NATIVE,
  probeAssetHubReserves,
  RELAY_NATIVE_DECIMALS,
  sizeCommitment,
  type Commitment,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  WITHDRAW_SOURCE_PREFIX,
  isWithdrawSourceId,
  type HostPaymentStatus,
  type WithdrawalHandoffPayload,
} from "../app/funding/requests/model";
import { hostSafeEntropy, nextFreeTradeNumber, readTradeCounter, tradeCounterKey } from "./coinage";
import { isHosted } from "./host-account";
import { createMemoryAdapter } from "@getsome/testing";
import {
  requestPayment as hostRequestPayment,
  subscribePaymentStatus,
  type PaymentStatus,
  type StatusSubscription,
} from "./host-payments";
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

/** The account a Meld sale's PAS lands on: the burner's OWN Asset Hub account, never the
 *  destination the user asked to receive at and never the provider's payout address (which is
 *  not known until the sale discloses it). The worker pays the provider onward from here once it
 *  is told where. Same bytes as the People address: Asset Hub decodes the identical account from
 *  them, the SS58 prefix being presentation only, so the "hex" form does not change across
 *  chains — see `assetHubAddressFor`. */
export function meldLandingHex(key: WithdrawKey): string {
  return key.publicKeyHex;
}

/** The per-order key a Meld sell session's idempotency key is minted under: the burner's own
 *  Asset Hub address, derived from the same key that will pay the provider. Stable across a
 *  reload — the same label re-derives the same key, hence the same address — and distinct per
 *  withdrawal, since every withdrawal derives its own key from its own number. This is what stops
 *  two sales in one corridor from resuming into each other; see `MeldSellSessionRequest.orderRef`.
 *  Never passed in by a caller: computing it here, from the key alone, is what makes "derived,
 *  never passed in loosely" true rather than merely documented. */
export function meldOrderRefFor(key: WithdrawKey): string {
  return assetHubAddressFor(key.publicKeyHex);
}

/** A planck amount as the whole-token decimal string Meld's sell session wants, at the relay
 *  native asset's full precision. Trims trailing fractional zeros; never scientific notation,
 *  since `amount` is already an integer. */
export function planckToDecimalString(amount: bigint, decimals = RELAY_NATIVE_DECIMALS): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (frac ? `.${frac}` : "");
}

// Browser-only deterministic seed when there is no host entropy root; the host always derives its own.
function browserEntropyPort(): { deriveSeed(label: Uint8Array): Promise<Uint8Array> } {
  return {
    async deriveSeed(label: Uint8Array): Promise<Uint8Array> {
      const out = new Uint8Array(32);
      label.forEach((b, i) => {
        out[i % 32] = (out[i % 32] ?? 0) ^ b;
      });
      return out;
    },
  };
}

/** Withdrawal `n`'s key, derived from the host's entropy root. */
export async function withdrawKeyFor(sourceId: string, n: number): Promise<WithdrawKey> {
  const entropy: { deriveSeed(label: Uint8Array): Promise<Uint8Array> } = isHosted()
    ? createHostEntropyPort(hostSafeEntropy(deriveEntropy))
    : browserEntropyPort();
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

/**
 * Sizes the exact DOT a Meld sale commits to: what Asset Hub's pool still pays out after a KYC
 * window's worth of adverse flow, less the transfer fee and existential deposit the payment
 * leaves behind, quantised to the provider's own precision. See `sizeCommitment` for the reasoning
 * behind the buffer; this is only the chain-reading side of it.
 *
 * The provider's payout address is not known this early — it only arrives once KYC concludes — so
 * the transfer-fee estimate is read against the burner's OWN address rather than the real one. A
 * same-shaped balance transfer's weight does not turn on whose account receives it, and the
 * worker's own overhead estimate, made once the real address is known, carries the same headroom
 * this one does (`ASSET_HUB_TRANSFER_FEE_HEADROOM_PCT`), so a difference between the two is
 * absorbed rather than fatal.
 */
export async function sizeMeldCommitment(
  key: WithdrawKey,
  cashToSell: bigint,
): Promise<Commitment> {
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const [reserves, quotedOut, overhead] = await Promise.all([
    probeAssetHubReserves(api, cashToSell, ASSET_HUB_POOL_FEE_PPM),
    api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
      CASH_ON_ASSET_HUB as never,
      PEOPLE_NATIVE as never,
      cashToSell,
      true,
    ),
    assetHubPaymentOverhead(api, key.publicKeyHex, { payoutAddress: key.address }),
  ]);
  if (quotedOut === undefined) throw new Error("Asset Hub cannot quote the sale");
  return sizeCommitment({
    cashToSell,
    reserves,
    poolFeePpm: ASSET_HUB_POOL_FEE_PPM,
    quotedOut,
    transferFeePlanck: overhead.transferFeePlanck,
    existentialDeposit: overhead.existentialDeposit,
  });
}

// Browser-only in-memory counter when there is no host store; never used in the host.
let browserStore: ReturnType<typeof createMemoryAdapter> | null = null;

async function hostStorageAdapter() {
  if (!isHosted()) {
    if (browserStore === null) browserStore = createMemoryAdapter();
    return browserStore;
  }
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

/** The hand-off for a withdrawal, with the chain facts this build is made for.
 *
 *  `meld` is left off until the sale has a provider payout address to give the worker: handing
 *  the worker a commitment it cannot pay out would either strand the run on a field nothing can
 *  fill in, or — far worse — let it run the chain legs not knowing where the sale must ultimately
 *  be paid onward. See `setWithdrawalMeldHandoff` in the requests store, which fills it in once
 *  the deposit is disclosed and the hand-off actually goes out. */
export function withdrawHandoff(args: {
  sourceId: string;
  n: number;
  key: WithdrawKey;
  amount: bigint;
  destination: WithdrawalHandoffPayload["destination"];
  landingHex: string;
  rail: WithdrawalHandoffPayload["rail"];
  paymentExpiresAt: number;
  meld?: WithdrawalHandoffPayload["meld"];
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
    ...(args.meld === undefined ? {} : { meld: args.meld }),
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

// The purse's payment to a withdrawal key is requested from the page, not the worker: the host
// shows its sheets, the approval and the privacy consent, to a page and to nothing else. The
// worker only watches the key the purse pays. The page SDK cannot make the request (its payment
// codec predates the id), so it goes over the host protocol client in host-payments, which shares
// the SDK's channel.

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.slice(2).match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));

/** The host refused a payment request; the message is the user's reason. */
export class PaymentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRefusedError";
  }
}

/** What the host's refusal means to the user. */
function refusalReason(error: unknown): string {
  if (error instanceof PaymentRequestErr.Rejected) return "The payment was declined.";
  if (error instanceof PaymentRequestErr.InsufficientBalance) {
    return "The balance does not cover this withdrawal.";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Asks the host to pay `amount` CASH to the key under `idHex`. Resolves once the host registered
 *  the payment, which is after the user's decision on its sheets, so a caller starts it and reads
 *  the answer back through the status. Idempotent on the id: a known id resolves at once and
 *  raises no second sheet. Throws PaymentRefusedError with the user's reason when the host
 *  refused. */
export async function requestKeyPayment(args: {
  idHex: string;
  amount: bigint;
  key: WithdrawKey;
}): Promise<void> {
  try {
    await hostRequestPayment(args.amount, fromHex(args.key.publicKeyHex), fromHex(args.idHex));
  } catch (error) {
    if (error instanceof PaymentRequestErr.AlreadyExists) return;
    throw new PaymentRefusedError(refusalReason(error));
  }
}

export interface PaymentStatusReading {
  status: HostPaymentStatus;
  reason?: string;
  /** Base units, when the host paid short. */
  actualClaimed?: string;
}

/** The first value of a host status subscription within `timeoutMs`; the subscription is closed
 *  right after. An interrupt before the first value rejects with the host's error. */
function firstStatus<T>(
  subscribe: (callback: (status: T) => void) => StatusSubscription,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let subscription: StatusSubscription | null = null;
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new Error(`payment status read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    subscription = subscribe((status) => {
      if (done) return;
      finish();
      resolve(status);
    });
    subscription.onInterrupt((error) => {
      if (done) return;
      finish();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (done) subscription.unsubscribe();
  });
}

/** One read of the host's word on payment `idHex`: its status when it has one, `not-found` for an
 *  id it does not know yet. Throws when the host could not be asked. */
export async function readPaymentStatus(idHex: string): Promise<PaymentStatusReading> {
  let status: PaymentStatus;
  try {
    status = await firstStatus<PaymentStatus>(
      (callback) => subscribePaymentStatus(fromHex(idHex), callback),
      PAYMENT_STATUS_DEADLINE_MS,
    );
  } catch (error) {
    if (error instanceof PaymentStatusErr.PaymentNotFound) return { status: "not-found" };
    throw error;
  }
  switch (status.type) {
    case "processing":
    case "completed":
      return { status: status.type };
    case "failed":
      return { status: "failed", reason: status.reason };
    case "partiallyClaimed":
      return { status: "partiallyClaimed", actualClaimed: status.actualClaimed.toString() };
  }
}
