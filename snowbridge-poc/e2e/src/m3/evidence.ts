import { nonceDelivered } from "../bridgehub";
import type { Ctx, Deposit } from "../harness";
import type { Scenario } from "../report";
import { INCLUDED, NOT_OURS, PROCESSED, RelayerLog, describeLine } from "../relayerLog";
import type { Api } from "../substrate";

// What the M3 scenarios share: the live relayer's log, Bridge Hub, and the deposits that serve as controls.
export type M3 = {
  ctx: Ctx;
  log: RelayerLog;
  bridgeHub: Api;
  // Relayer log offset at the start of the run.
  since: number;
  delivered: Deposit[];
};

const LOG_WAIT_MS = 90_000;

// The relayer's own account of a message of ours: it put the nonce in a batch and never screened it out. Only the batch path
// confirms each message afterwards ("successfully processed"); the catch-up path, which carries a beacon update with it, does not.
export async function oursEvidence(m: M3, s: Scenario, name: string, nonce: bigint, from = m.since): Promise<void> {
  const included = await m.log.waitFor(`nonce ${nonce} in a batch`, from, INCLUDED, nonce, LOG_WAIT_MS);
  const processed = m.log.find(from, PROCESSED, nonce)[0];
  s.ref(`${name}: relayer log, batched`, describeLine(included));
  if (processed) s.ref(`${name}: relayer log, processed`, describeLine(processed));
  s.check(`${name}: the relayer log shows nonce ${nonce} batched for delivery`, true, processed ? `${included.time}, confirmed ${processed.time}` : `${included.time}, ${included.message}`);
  s.check(`${name}: the relayer never screened nonce ${nonce} out`, m.log.find(from, NOT_OURS, nonce).length === 0);
  s.check(`${name}: Bridge Hub's nonce bitmap has nonce ${nonce} set`, await nonceDelivered(m.bridgeHub, nonce));
}

// The relayer screened the message out and, long after normal delivery time, Bridge Hub has still not seen it.
export async function notOursEvidence(m: M3, s: Scenario, name: string, nonce: bigint, from = m.since): Promise<void> {
  const screened = await m.log.waitFor(`nonce ${nonce} screened out`, from, NOT_OURS, nonce, LOG_WAIT_MS);
  s.ref(`${name}: relayer log, screened`, describeLine(screened));
  s.check(`${name}: the relayer log shows nonce ${nonce} screened out as not ours`, true, screened.time);
  s.check(`${name}: the relayer never batched nonce ${nonce}`, m.log.find(from, INCLUDED, nonce).length === 0);
  s.check(`${name}: Bridge Hub's nonce bitmap does not have nonce ${nonce} set`, !(await nonceDelivered(m.bridgeHub, nonce)));
}
