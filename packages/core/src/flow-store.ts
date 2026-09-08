// Persisted flow-state store, versioned and keyed by (sourceId, recipient).

import type { SettlementAsset } from "./action";
import type { StorageAdapter } from "./ports";
import type { PaymentPhase, SourceId } from "./state";

export const FLOW_SCHEMA_VERSION = 2 as const;

/**
 * 'spend' = action + ephemeral; 'deliver' = direct egress to the recipient;
 * 'handoff' = ephemeral + host-side settlement (HandoffAction).
 */
export type FlowMode = "spend" | "deliver" | "handoff";

export interface FlowState {
  version: typeof FLOW_SCHEMA_VERSION;
  mode: FlowMode;
  sourceId: SourceId;
  recipient: string;
  /** Spend + handoff modes; deliver has no ephemeral. */
  ephemeralAddress?: string;
  phase: PaymentPhase;
  createdAt: number;
  /** Scopes the idempotency probe to this attempt. */
  idempotencyKey: string;
  /** Opaque caller payload, round-tripped verbatim (never inspected). */
  payload: string;
  /** Contract charge in EVM 18-dec, stringified bigint ('0' in deliver/handoff modes). */
  priceEvm: string;
  /** Handoff mode only: the exact settle amount (base units), stringified bigint. */
  handoffAmount?: string;
  settlement: SettlementAsset;
  /** Deliver mode: the witnessed egress txRef once complete (the Receipt id across resume). */
  deliverTxRef?: string;
  depositAddress?: string;
  depositChannelId?: string;
  depositExpiresAt?: number;
  /** Source base units to send, stringified bigint. */
  depositAmount?: string;
  /** Ceil-rounded human amount ("0.0043 BTC"), persisted verbatim. */
  depositFormatted?: string;
  depositAssetSymbol?: string;
  errorMessage?: string;
}

/** Storage key for one (sourceId, recipient) flow slot. */
export function flowStorageKey(sourceId: SourceId, recipient: string): string {
  return `onramp:v${FLOW_SCHEMA_VERSION}:${sourceId}:${recipient}`;
}

export interface FlowStore {
  load(): Promise<FlowState | null>;
  save(state: FlowState): Promise<void>;
  clear(): Promise<void>;
}

export function createFlowStore(
  storage: StorageAdapter,
  sourceId: SourceId,
  recipient: string,
): FlowStore {
  const key = flowStorageKey(sourceId, recipient);
  return {
    async load() {
      try {
        const raw = await storage.read(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as FlowState;
        // A foreign schema version is treated as absent.
        if (parsed.version !== FLOW_SCHEMA_VERSION) return null;
        return parsed;
      } catch {
        // unreadable slot (transport error or corrupt JSON) is treated as absent
        return null;
      }
    },
    async save(state) {
      await storage.write(key, JSON.stringify(state));
    },
    async clear() {
      await storage.clear(key);
    },
  };
}
