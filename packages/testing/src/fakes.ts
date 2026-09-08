// Fake harness: a scriptable ChainPort and PaymentAction sharing state. Models a submit that
// succeeds, one that throws after the tx landed, and one that throws with nothing landed.

import type {
  ActionCall,
  ActionContext,
  ChainPort,
  EphemeralSigner,
  IdempotencyKey,
  PaymentAction,
  PriceEvm,
  SettlementAsset,
  SettlePlan,
  SubmitOutcome,
  Subscription,
} from "@getsome/core";

export interface HarnessOptions {
  /** Ephemeral free balance the fake ChainPort reports. */
  balance?: bigint;
  /**
   * When set, settlementBalance reports this while freeBalance keeps reporting `balance`. Default:
   * mirrors `balance`.
   */
  settlementBalance?: bigint;
  /** settlementBalance/watchSettlementBalance throw (models a port without this asset). */
  settlementUnsupported?: boolean;
  /** Start with the action already complete (models a prior successful attempt). */
  startComplete?: boolean;
  /** A successful submit marks the action complete (the happy path). Default true. */
  landOnSubmit?: boolean;
  /** This many submits throw before any succeed. */
  failSubmits?: number;
  /** When a submit throws, did the tx still "land" on chain first? */
  failButLand?: boolean;
  /** The opaque result id the action reports once complete. */
  resultId?: number | string;
}

export interface Harness {
  action: PaymentAction<unknown>;
  chain: ChainPort;
  signer: EphemeralSigner;
  /** Live observability for assertions. */
  readonly stats: {
    submits: number;
    probes: number;
    builds: number;
    sweeps: number;
    complete: boolean;
    lastSettle: SettlePlan | null;
    lastSweepDest: string | null;
    lastSettlementRead: SettlementAsset | null;
    probedKeys: string[];
  };
  setBalance(balance: bigint): void;
  /** Diverge the settlement-asset balance from the native one (null = mirror native). */
  setSettlementBalance(balance: bigint | null): void;
  /** Externally mark the action complete (models an out-of-band landing). */
  markComplete(): void;
}

export function createFakeHarness(opts: HarnessOptions = {}): Harness {
  const state = {
    balance: opts.balance ?? 0n,
    settlementBalance: opts.settlementBalance ?? null,
    settlementUnsupported: opts.settlementUnsupported ?? false,
    complete: opts.startComplete ?? false,
    landOnSubmit: opts.landOnSubmit ?? true,
    failSubmits: opts.failSubmits ?? 0,
    failButLand: opts.failButLand ?? false,
    resultId: opts.resultId ?? 42,
    submits: 0,
    probes: 0,
    builds: 0,
    sweeps: 0,
    lastSettle: null as SettlePlan | null,
    lastSweepDest: null as string | null,
    lastSettlementRead: null as SettlementAsset | null,
    probedKeys: [] as string[],
    watchers: new Set<(free: bigint) => void>(),
  };

  const action: PaymentAction<unknown> = {
    async buildCall(_ctx: ActionContext, _payload: unknown, _price: PriceEvm): Promise<ActionCall> {
      state.builds += 1;
      return { dest: "0xc0ntract0000000000000000000000000000dead", data: "0xdeadbeef" };
    },
    async isComplete(key: IdempotencyKey) {
      state.probes += 1;
      state.probedKeys.push(key);
      return state.complete ? { id: state.resultId } : null;
    },
  };

  const signer: EphemeralSigner = {
    address: "5EphemeralFakeAddrPrefix000000000000000000000",
    signer: {},
  };

  const chain: ChainPort = {
    async freeBalance() {
      return state.balance;
    },
    watchFreeBalance(_ss58: string, cb: (free: bigint) => void): Subscription {
      state.watchers.add(cb);
      return {
        unsubscribe() {
          state.watchers.delete(cb);
        },
      };
    },
    // `settlementBalance` diverges from the native `balance` when scripted; lastSettlementRead
    // records the settlement requested.
    async settlementBalance(_ss58: string, settlement: SettlementAsset) {
      if (state.settlementUnsupported) {
        throw new Error(`settlementBalance for kind '${settlement.kind}' is not wired (fake)`);
      }
      state.lastSettlementRead = settlement;
      return state.settlementBalance ?? state.balance;
    },
    watchSettlementBalance(
      _ss58: string,
      settlement: SettlementAsset,
      cb: (balance: bigint) => void,
    ): Subscription {
      if (state.settlementUnsupported) {
        throw new Error(`watchSettlementBalance for kind '${settlement.kind}' is not wired (fake)`);
      }
      state.lastSettlementRead = settlement;
      state.watchers.add(cb);
      return {
        unsubscribe() {
          state.watchers.delete(cb);
        },
      };
    },
    async submit(
      _call: ActionCall,
      _signer: EphemeralSigner,
      settle: SettlePlan,
    ): Promise<SubmitOutcome> {
      state.submits += 1;
      state.lastSettle = settle;
      if (state.failSubmits > 0) {
        state.failSubmits -= 1;
        if (state.failButLand) state.complete = true; // landed, THEN the RPC errored
        throw new Error("rpc timeout");
      }
      if (state.landOnSubmit) state.complete = true;
      return { ok: true, txRef: "0xtx" };
    },
    async sweep(
      dest: string,
      _signer: EphemeralSigner,
      _settlement: SettlementAsset,
    ): Promise<SubmitOutcome> {
      state.sweeps += 1;
      state.lastSweepDest = dest;
      state.balance = 0n;
      return { ok: true, txRef: "0xsweep" };
    },
    api: {},
  };

  return {
    action,
    chain,
    signer,
    get stats() {
      return {
        submits: state.submits,
        probes: state.probes,
        builds: state.builds,
        sweeps: state.sweeps,
        complete: state.complete,
        lastSettle: state.lastSettle,
        lastSweepDest: state.lastSweepDest,
        lastSettlementRead: state.lastSettlementRead,
        probedKeys: [...state.probedKeys],
      };
    },
    setBalance(balance: bigint) {
      state.balance = balance;
    },
    setSettlementBalance(balance: bigint | null) {
      state.settlementBalance = balance;
    },
    markComplete() {
      state.complete = true;
    },
  };
}
