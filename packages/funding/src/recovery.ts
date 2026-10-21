// The recovery of a trapped top-up: the burner claims its CASH back from People's trap once it
// holds the fee for the claim.
//
// claim_assets names the trapped assets exactly and deposits them to the burner. People takes the
// transaction fee in CASH, so the burner needs a little CASH first: the purse pays it, asked by
// the page through the host, or a small deposit the user makes on the burner's Asset Hub account
// becomes CASH on People through the funding pipeline, as any top-up does. Either way the
// recovery only watches the burner's CASH on People and claims when it covers the fee.
//
// THE CLAIM IS ONE SIGNED TRANSACTION, DRY-RUN FIRST. A claim that would fail costs its fee and
// changes nothing, so People runs it as the burner before it is paid for. Its answer lost, the
// trap's count at the next tick says what became of it: zero, the CASH is on the burner; still
// counted, the claim is sent again once the nonce it was signed at has moved, or once enough time
// has passed for a dropped submit to be out of its mortality. Two claims for one trap would have
// the second refused with its fee gone, so one waits on the other.
//
// THE FEE IS SIZED ONCE, WITH THE MARGIN, IN CASH. The chain prices a transaction in the native
// and charges the CASH that its asset rate makes of it; the estimate here follows the same two
// steps. The page asks the purse for it, rounded up to what the host can pay; what the fee does
// not take lands in the purse with the recovered CASH. The fee is sized again only when People's
// pool refuses the claim, which is how a fee grown past the margin shows; the round then moves
// on, so the surface knows a payment made before it no longer counts. A claim rejected at
// inclusion spends the fee and moves the round on the same way.

import { InvalidTxError, type PolkadotSigner } from "polkadot-api";
import { TOKENS } from "@getsome/core";
import { describeDispatchError } from "./dispatch-error";
import { withFeeMargin, type PeopleApi } from "./funding-program";
import { bounded } from "./pipeline";
import { trappedCash, type Trap } from "./trap";
import { signedOrigin } from "./xcm-dry-run";

/** Signing on People from a key that holds only CASH: the fee is charged in CASH, and People's
 *  extra signed extension is passed disabled, which papi's default signer does not do on its
 *  own. The same options price the fee. */
export const PEOPLE_CASH_TX_OPTIONS = {
  asset: TOKENS.CASH.locationOnPeople,
  customSignedExtensions: { VerifyMultiSignature: { value: { type: "Disabled" } } },
} as const;

/** How long a claim whose answer was lost is waited for before it is sent again: past People's
 *  default mortality for a signed transaction, so the first can no longer land. */
export const CLAIM_RESEND_MS = 10 * 60_000;

/** Cross-tick memory of one recovery. The driver persists it; `tickRecovery` mutates it. */
export interface RecoveryState {
  /** The claim's fee in CASH with the margin, sized once; what the burner must hold. */
  feeCash: bigint | null;
  /** The fee's round: it moves on when a claim spent the fee or the fee grew, so a payment made
   *  in an earlier round no longer counts. */
  round: number;
  /** The burner's CASH on People at the last read; null before the first. */
  held: bigint | null;
  /** Claims sent so far, rejected ones included. */
  attempts: number;
  /** The burner's nonce on People when the last claim was sent; null while none is owed an
   *  answer. */
  nonceAtClaim: number | null;
  /** When the last claim was sent (ms); null with `nonceAtClaim`. */
  claimSentAt: number | null;
}

export const freshRecoveryState = (): RecoveryState => ({
  feeCash: null,
  round: 0,
  held: null,
  attempts: 0,
  nonceAtClaim: null,
  claimSentAt: null,
});

/** Where a recovery stands: waiting for the fee, waiting for a sent claim, or claimed. */
export type RecoveryStep = "funding" | "claiming" | "done";

export interface RecoveryTickInput {
  peopleApi: PeopleApi;
  /** The burner, passed as address and signer; its public key is the claimer the trap names. */
  address: string;
  signer: PolkadotSigner;
  claimerHex: string;
  trap: Trap;
  /** The burner's CASH on People at a block tag. */
  readCashOnPeople: (ss58: string, at: "best" | "finalized") => Promise<bigint>;
  tickTimeoutMs: number;
  /** Bound on the claim's submit; past it the tick throws and a later tick settles from the
   *  chain what became of it. */
  submitTimeoutMs: number;
  now: () => number;
  /** Runs right before the broadcast, once `state` holds what a wake mid-send needs. */
  onBeforeSubmit?: () => Promise<void> | void;
  /** The claim's hash and block, reported once it is in. */
  onTx?: (info: { call: "claim"; txHash: string; block?: number; ok: boolean }) => void;
}

export interface RecoveryOutcome {
  step: RecoveryStep;
  /** The burner's CASH on People at the latest block. */
  held: bigint;
  /** The fee the burner must hold, as sized. */
  feeCash: bigint;
}

const account = (hex: string) => ({
  type: "V5",
  value: {
    parents: 0,
    interior: {
      type: "X1",
      // papi encodes fixed-size binaries from their hex-string form; a raw Uint8Array mis-encodes.
      value: { type: "AccountId32", value: { network: undefined, id: hex } },
    },
  },
});

/** The claim: the trapped CASH, named exactly, deposited to the burner. */
export function buildClaim(peopleApi: PeopleApi, claimerHex: string, trap: Trap) {
  return peopleApi.tx.PolkadotXcm.claim_assets({
    assets: trappedCash(trap.amount),
    beneficiary: account(claimerHex),
  } as never);
}

/** The scale of People's asset rate, a fixed-point number with 18 places. */
const RATE_ONE = 10n ** 18n;

/** A native fee as the CASH People charges for it: divided by the rate, rounded up where the
 *  chain rounds down, so the estimate never comes in under the charge. */
export function nativeFeeInCash(native: bigint, rate: bigint): bigint {
  if (rate <= 0n) throw new Error("claim fee: People's rate for CASH is zero");
  return (native * RATE_ONE + rate - 1n) / rate;
}

/** The claim's fee in CASH, with the margin on top: the chain's own native estimate for the
 *  exact transaction, made CASH by the asset rate the fee payment uses. */
export async function sizeClaimFee(
  peopleApi: PeopleApi,
  address: string,
  claimerHex: string,
  trap: Trap,
): Promise<bigint> {
  const [native, rate] = await Promise.all([
    buildClaim(peopleApi, claimerHex, trap).getEstimatedFees(
      address,
      PEOPLE_CASH_TX_OPTIONS as never,
    ),
    peopleApi.query.AssetRate.ConversionRateToNative.getValue(
      TOKENS.CASH.locationOnPeople as never,
      { at: "best" },
    ),
  ]);
  if (rate === undefined) throw new Error("claim fee: People has no rate for CASH");
  return withFeeMargin(nativeFeeInCash(native, rate));
}

/**
 * One reading of the trap and the burner, and at most one claim. Retryable by calling again; the
 * only terminal signal is the returned "done", which means the CASH is on the burner.
 */
export async function tickRecovery(
  input: RecoveryTickInput,
  state: RecoveryState,
): Promise<RecoveryOutcome> {
  const { peopleApi, address, claimerHex, trap } = input;
  const read = <T>(work: Promise<T>, what: string) => bounded(work, input.tickTimeoutMs, what);

  // The trap's count is the claim's answer, whoever asked: zero, the CASH is on the burner.
  const count = await read(
    peopleApi.query.PolkadotXcm.AssetTraps.getValue(trap.key, { at: "best" }),
    "trap read",
  );
  if (state.feeCash === null) {
    state.feeCash = await read(sizeClaimFee(peopleApi, address, claimerHex, trap), "claim fee");
  }
  const feeCash = state.feeCash;
  const held = await read(input.readCashOnPeople(address, "best"), "burner CASH read");
  state.held = held;
  if (count === 0) {
    state.nonceAtClaim = null;
    state.claimSentAt = null;
    return { step: "done", held, feeCash };
  }
  if (held < feeCash) {
    // The burner held the fee when a claim went out and holds less now with the trap still
    // counted: that claim landed rejected while its answer was lost, and spent the fee. The round
    // moves on so the fee is asked for again.
    if (state.nonceAtClaim !== null) {
      state.nonceAtClaim = null;
      state.claimSentAt = null;
      state.round += 1;
    }
    return { step: "funding", held, feeCash };
  }

  // A claim owed an answer: wait for it while its nonce stands and it may still land.
  const nonce = await read(
    peopleApi.apis.AccountNonceApi.account_nonce(address, { at: "best" }),
    "nonce read",
  );
  if (state.nonceAtClaim !== null && state.claimSentAt !== null) {
    const inFlight =
      nonce === state.nonceAtClaim && input.now() - state.claimSentAt < CLAIM_RESEND_MS;
    if (inFlight) return { step: "claiming", held, feeCash };
  }

  // People runs the claim as the burner before it is paid for; one it would refuse is not sent.
  const claim = buildClaim(peopleApi, claimerHex, trap);
  const dr = await read(
    peopleApi.apis.DryRunApi.dry_run_call(
      signedOrigin(address) as never,
      claim.decodedCall as never,
      5,
    ),
    "claim dry run",
  );
  if (!dr.success)
    throw new Error(`claim not sent: People would not dry-run it (${dr.value.type})`);
  if (!dr.value.execution_result.success) {
    const { error } = dr.value.execution_result.value;
    throw new Error(`claim not sent: People rejects it: ${describeDispatchError(error)}`);
  }

  state.nonceAtClaim = nonce;
  state.claimSentAt = input.now();
  state.attempts += 1;
  await input.onBeforeSubmit?.();
  let res;
  try {
    res = await bounded(
      claim.signAndSubmit(input.signer, PEOPLE_CASH_TX_OPTIONS as never),
      input.submitTimeoutMs,
      "claim submit",
    );
  } catch (error) {
    // The pool would not take it: nothing is in flight and nothing was spent. The usual cause is
    // a fee grown past the sizing, so it is sized again; grown past what the burner holds, the
    // round moves on and the shortfall is asked for.
    if (error instanceof InvalidTxError) {
      state.nonceAtClaim = null;
      state.claimSentAt = null;
      state.attempts -= 1;
      const fresh = await read(sizeClaimFee(peopleApi, address, claimerHex, trap), "claim fee");
      if (fresh > feeCash) {
        state.feeCash = fresh;
        if (held < fresh) state.round += 1;
      }
    }
    // Any other answer, a timeout among them, may have left the claim in flight: the marker
    // stands and the next tick settles it from the trap's count and the nonce.
    throw error;
  }
  input.onTx?.({ call: "claim", txHash: res.txHash, block: res.block?.number, ok: res.ok });
  if (!res.ok) {
    // Refused at inclusion and the fee gone: the round moves on, and the next tick reads the
    // trap again and asks for the fee afresh.
    state.nonceAtClaim = null;
    state.claimSentAt = null;
    state.round += 1;
    throw new Error(`claim rejected: ${describeDispatchError(res.dispatchError)}`);
  }
  state.nonceAtClaim = null;
  state.claimSentAt = null;
  const after = await read(input.readCashOnPeople(address, "best"), "burner CASH read");
  state.held = after;
  return { step: "done", held: after, feeCash };
}
