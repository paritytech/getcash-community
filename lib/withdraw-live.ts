// Hosted seams of a withdrawal: the disposable key the purse pays, the purse's payment to it, the
// key's CASH on People, and the hand-off to the worker. The chain legs run in the product's
// worker, and so does the payment call, since the worker is the host's payment client for the
// top-up claims already; this page hands the request over and reads it back, as coinage-live
// does for the on-ramp.

import { PaymentRequestErr, PaymentStatusErr } from "@novasamatech/host-api";
import { deriveEntropy, getHostLocalStorage } from "@parity/product-sdk-host";
import { deriveKeypair, walletSeedHex } from "@getsome/ephemeral";
import { PASEO_ASSET_HUB_PARA_ID, PASEO_PEOPLE_PARA_ID } from "@getsome/funding";
import {
  createHostEntropyPort,
  createHostStorageAdapter,
  type HostLocalStorageLike,
} from "@getsome/host";
import { CASH_DECIMALS, CASH_LOCATION } from "@getsome/people";
import {
  CASH_ON_ASSET_HUB,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  PASEO_PEOPLE_POOL_ACCOUNT,
  PEOPLE_NATIVE,
  readDestinationPas,
} from "@getsome/withdraw";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  WITHDRAW_SOURCE_PREFIX,
  isWithdrawSourceId,
  type HostPaymentStatus,
  type WithdrawalChannel,
  type WithdrawalHandoffPayload,
} from "../app/funding/requests/model";
import {
  BelowMinimumSwapAmountError,
  ChainflipRequestError,
  formatSourceAmount,
  openWithdrawChannel,
  quoteOutgoing,
  SOURCE_CONFIG_BY_ID,
  type IncludedFee,
  type OutgoingQuote,
} from "@getsome/chainflip";
import { AccountId } from "polkadot-api";
import { cashAmount } from "../app/utils/cash";
import type { WithdrawFeeView, WithdrawOffer } from "../app/withdraw/offers";
import { mainnetSdk } from "./chainflip-backend";
import { withTimeout } from "./timeout";
import { hostSafeEntropy, nextFreeTradeNumber, readTradeCounter, tradeCounterKey } from "./coinage";
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

/** Withdrawal `n`'s key, derived from the host's entropy root. */
export async function withdrawKeyFor(sourceId: string, n: number): Promise<WithdrawKey> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  const seed = await entropy.deriveSeed(
    new TextEncoder().encode(withdrawEntropyLabel(sourceId, n)),
  );
  const keypair = deriveKeypair(seed);
  return { address: keypair.address, publicKeyHex: toHex(keypair.publicKey) };
}

export interface WithdrawRefundKey {
  /** The key on Asset Hub, where a provider's refund lands. */
  address: string;
  /** The raw seed a wallet imports for the same account, hex. */
  secret: string;
}

/** The withdrawal key re-derived from its record's entropy label, with the wallet-importable
 *  seed. Read on tap, never on load; throws outside a host, where there is no entropy root. */
export async function revealWithdrawKey(label: string): Promise<WithdrawRefundKey> {
  const entropy = createHostEntropyPort(hostSafeEntropy(deriveEntropy));
  const seed = await entropy.deriveSeed(new TextEncoder().encode(label));
  const keypair = deriveKeypair(seed);
  return { address: keypair.address, secret: walletSeedHex(seed) };
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
 *  Paseo: the People swap for the fee PAS, about 0.42 CASH, and Asset Hub's execution fee.
 *  Exported for the fee drill-in, which shows it as the direct rail's one fee. */
export const DIRECT_FEES_CASH = 450_000n;

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

/** The CASH a direct withdrawal must take for `native` planck to land on Asset Hub, at today's
 *  pool price: what exactly that much native costs, plus the fees the program takes on the way. */
export async function quoteDirectCashFor(native: bigint): Promise<bigint> {
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const quoted = await api.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(
    CASH_ON_ASSET_HUB as never,
    PEOPLE_NATIVE as never,
    native,
    true,
  );
  if (quoted === undefined) throw new Error("Asset Hub cannot quote the purchase");
  return quoted + DIRECT_FEES_CASH;
}

/** Headroom between the pool's answer and what the provider is asked to take: the sale on Asset
 *  Hub may slip by up to the program's own tolerance and still go through, and the sweep's fee
 *  comes off the deposit after that. The provider is quoted for the worst case the program
 *  allows, so a withdrawal that passes here lands enough to swap. */
const PROVIDER_QUOTE_HEADROOM_PCT = BigInt(DEFAULT_WITHDRAW_SLIPPAGE_PCT) + 1n;
/** Ceiling on the wait for the offers. */
const OFFERS_TIMEOUT_MS = 15_000;

/** The design's fee rows: what the networks charged, Chainflip's own cut, ours. */
const FEE_GROUPS: readonly { label: string; types: readonly string[] }[] = [
  { label: "Network fee", types: ["INGRESS", "EGRESS", "BOOST"] },
  { label: "Swap fee", types: ["NETWORK"] },
  { label: "Service fee", types: ["BROKER"] },
];

/** Stables read naturally at cents; everything else keeps the payout's own precision. */
const feeDecimals = (config: { decimals: number }): number => (config.decimals <= 6 ? 2 : 6);

/** Digits a payout is stated to, on the summary and in the drill-in alike. */
const PAYOUT_DECIMALS = 6;

/** A fee, at the cents a fee reads best in. Rounded up, which overstates the charge: the safe
 *  direction for a fee, and the wrong one for a payout. */
const fmtDest = (config: { asset: string; decimals: number }, planck: bigint): string =>
  `${formatSourceAmount(config, planck, { maxDecimals: feeDecimals(config) })} ${config.asset}`;

/**
 * What lands, at the payout's own precision — the summary's figure and the drill-in's, from one
 * place so the two cannot disagree.
 *
 * Not `fmtDest`: `formatSourceAmount` rounds up, so a stable capped at cents would promise a cent
 * more than the swap pays out (24.500001 USDC reading as 24.51).
 */
const fmtPayout = (config: { asset: string; decimals: number }, planck: bigint): string =>
  `${formatSourceAmount(config, planck, { maxDecimals: PAYOUT_DECIMALS })} ${config.asset}`;

/** "$1 CASH ≈ 0.99 USDC": the gross rate `equivalent` implies for the CASH withdrawn. */
function grossRate(
  config: { asset: string; decimals: number },
  equivalent: bigint,
  amountCash: bigint,
): string | null {
  const cash = Number(amountCash) / 10 ** CASH_DECIMALS;
  const value = Number(equivalent) / 10 ** config.decimals / cash;
  if (!Number.isFinite(value) || value <= 0) return null;
  const figure = value >= 0.01 ? value.toFixed(2) : value.toPrecision(2);
  return `${cashAmount("1")} ≈ ${figure} ${config.asset}`;
}

/**
 * The quote's fee split priced into the destination asset with the quote's own numbers: a DOT fee
 * at the deposit-to-egress ratio, a USDC fee at the intermediate-to-egress ratio. An estimate for
 * the drill-in, not what the swap is held to. A fee neither rule can price, or of a kind the rows
 * don't name, drops the whole view: better no split than one that does not add up.
 */
function offerFees(
  config: { asset: string; decimals: number },
  quote: OutgoingQuote,
  amountCash: bigint,
): WithdrawFeeView | undefined {
  const inDest = (fee: IncludedFee): bigint | null => {
    if (fee.asset === config.asset) return fee.amount;
    if (fee.asset === "DOT" && quote.depositAmount > 0n)
      return (fee.amount * quote.egressAmount) / quote.depositAmount;
    if (fee.asset === "USDC" && quote.intermediateAmount !== null && quote.intermediateAmount > 0n)
      return (fee.amount * quote.egressAmount) / quote.intermediateAmount;
    return null;
  };
  if (quote.includedFees.length === 0) return undefined;
  if (quote.includedFees.some((fee) => !FEE_GROUPS.some((g) => g.types.includes(fee.type))))
    return undefined;
  const rows: { label: string; value: string }[] = [];
  let total = 0n;
  for (const group of FEE_GROUPS) {
    let sum = 0n;
    for (const fee of quote.includedFees) {
      if (!group.types.includes(fee.type)) continue;
      const priced = inDest(fee);
      if (priced === null) return undefined;
      sum += priced;
    }
    if (sum > 0n) {
      rows.push({ label: group.label, value: fmtDest(config, sum) });
      total += sum;
    }
  }
  const equivalent = quote.egressAmount + total;
  return {
    rows,
    ...(rows.length ? { total: fmtDest(config, total) } : {}),
    equivalent: `≈ ${fmtPayout(config, equivalent)}`,
    receive: fmtPayout(config, quote.egressAmount),
    rate: grossRate(config, equivalent, amountCash),
  };
}

const withHeadroom = (native: bigint): bigint =>
  native + (native * PROVIDER_QUOTE_HEADROOM_PCT) / 100n;
const lessHeadroom = (native: bigint): bigint =>
  native - (native * PROVIDER_QUOTE_HEADROOM_PCT) / 100n;

/**
 * What every provider destination offers for `amountCash`: the pool prices the CASH into native,
 * the headroom comes off, and each destination is quoted for what is left. One refused quote
 * says the amount is under the provider's minimum, priced back into CASH; a provider that is not
 * answering marks every destination after the first, without asking the rest. Never throws.
 */
export async function quoteWithdrawOffers(
  amountCash: bigint,
  destinations: readonly { id: string; chain: string; asset: string }[],
): Promise<{ sellable: bigint | null; offers: ReadonlyMap<string, WithdrawOffer> }> {
  const offers = new Map<string, WithdrawOffer>();
  const allUnavailable = (reason: string) => {
    for (const destination of destinations)
      offers.set(destination.id, { state: "unavailable", reason });
    console.warn(`[withdraw] offers unavailable: ${reason}`);
    return { sellable: null, offers };
  };

  let sellable: bigint;
  let sdk: Awaited<ReturnType<typeof mainnetSdk>>;
  try {
    [sellable, sdk] = await withTimeout(
      Promise.all([quoteDirectReceive(amountCash).then(lessHeadroom), mainnetSdk()]),
      OFFERS_TIMEOUT_MS,
      "withdraw offers",
    );
  } catch (e) {
    return allUnavailable(messageOf(e));
  }

  // An amount the fees eat whole sells for nothing; a quote for one planck still makes Chainflip
  // name its minimum, which is the answer such a row needs.
  const probe = sellable > 0n ? sellable : 1n;
  // The minimum is on the DOT sold, so every destination names the same one: priced once.
  const minimumCashFor = new Map<bigint, Promise<bigint>>();
  const tooSmall = async (minimum: bigint): Promise<WithdrawOffer> => {
    let priced = minimumCashFor.get(minimum);
    if (priced === undefined) {
      priced = quoteDirectCashFor(withHeadroom(minimum));
      minimumCashFor.set(minimum, priced);
    }
    try {
      return { state: "too-small", minimumCash: await priced };
    } catch (e) {
      return { state: "unavailable", reason: messageOf(e) };
    }
  };

  const quoteOne = async (destination: {
    id: string;
    chain: string;
    asset: string;
  }): Promise<{ offer: WithdrawOffer; outage: boolean }> => {
    const config = providerDestination(destination);
    try {
      const quote = await withTimeout(
        quoteOutgoing(sdk, probe, config),
        OFFERS_TIMEOUT_MS,
        `${config.asset} offer`,
      );
      const fees = offerFees(config, quote, amountCash);
      return {
        offer: {
          state: "available",
          egress: quote.egressAmount,
          formatted: fmtPayout(config, quote.egressAmount),
          etaSeconds: quote.estimatedDurationSeconds,
          ...(fees === undefined ? {} : { fees }),
        },
        outage: false,
      };
    } catch (e) {
      if (e instanceof BelowMinimumSwapAmountError) {
        return { offer: await tooSmall(e.minimumBaseUnits), outage: false };
      }
      return {
        offer: { state: "unavailable", reason: messageOf(e) },
        outage: e instanceof ChainflipRequestError && e.outage,
      };
    }
  };

  // The first destination is asked alone: a provider that is not answering says so once.
  const [first, ...rest] = destinations;
  if (first === undefined) return { sellable, offers };
  const canary = await quoteOne(first);
  offers.set(first.id, canary.offer);
  if (canary.outage && canary.offer.state === "unavailable") {
    const { reason } = canary.offer;
    for (const destination of rest) offers.set(destination.id, { state: "unavailable", reason });
    console.warn(`[withdraw] offers unavailable: ${reason}`);
    return { sellable, offers };
  }
  await Promise.all(
    rest.map(async (destination) => {
      offers.set(destination.id, (await quoteOne(destination)).offer);
    }),
  );
  return { sellable, offers };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

/** The key's free native on Asset Hub at the current head: what a provider refunded, when the
 *  swap could not fill, and what a fresh channel is quoted for. */
export async function readWithdrawKeyNativeOnAssetHub(keyPublicKeyHex: string): Promise<bigint> {
  const { connectChain, ASSET_HUB } = await import("./host-chain");
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  return readDestinationPas(api, keyPublicKeyHex);
}

/** A provider destination's asset and chain, as Chainflip names them, with the asset's decimals
 *  for showing what lands. */
function providerDestination(destination: { id: string; chain: string; asset: string }) {
  const config = SOURCE_CONFIG_BY_ID.get(destination.id as never);
  if (config === undefined) {
    throw new Error(`no Chainflip source for the ${destination.asset} destination`);
  }
  return config;
}

/** Opens the provider's channel for a withdrawal, with the key on Asset Hub as the refund. */
export async function openWithdrawChannelFor(args: {
  amountNative: bigint;
  destination: { id: string; chain: string; asset: string; address: string };
  keyPublicKeyHex: string;
}): Promise<WithdrawalChannel> {
  const config = providerDestination(args.destination);
  const channel = await openWithdrawChannel({
    sdk: await mainnetSdk(),
    amount: args.amountNative,
    destination: { chain: config.chain, asset: config.asset, address: args.destination.address },
    refundAddress: AccountId(0).dec(args.keyPublicKeyHex as `0x${string}`),
  });
  return {
    id: channel.id,
    address: channel.address,
    openedAt: Date.now(),
    expiresAt: channel.expiresAt,
    expectedEgress: channel.expectedEgress.toString(),
  };
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
  channel?: WithdrawalChannel;
}): WithdrawalHandoffPayload {
  return {
    ...(args.channel === undefined ? {} : { channel: args.channel }),
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

/** Dev builds only: tells the worker to take a withdrawal's swap as delivered. On a test network
 *  the provider's channel is real but cannot be paid, so the walk ends here by hand. */
export function skipWithdrawRail(worker: WorkerLike, sessionId: string): Promise<unknown> {
  return worker.call("skipWithdrawRail", { sessionId });
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
