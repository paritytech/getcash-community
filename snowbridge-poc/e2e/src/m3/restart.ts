import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { finalizedBeaconSlot } from "../bridgehub";
import { publicClient, waitFor } from "../chains";
import { ONE, awaitSettled, awaitTrigger, balanceOf, same, startDeposit } from "../harness";
import { DEAD_NONCES, restartEthereumRelayer } from "../relayer";
import { NOT_OURS, OURS_MODE, describeLine } from "../relayerLog";
import type { Scenario } from "../report";
import { notOursEvidence, oursEvidence, type M3 } from "./evidence";
import type { Rotated } from "./rotation";
import type { Strangers } from "./strangers";

// A nonce no message will ever have, put in the dead-nonce file to show that a restarted relayer loads that file.
const SENTINEL_NONCE = "9999999";

// The ethereum-v3 process is killed after the trigger and before delivery. The stack's loop starts it again, it rebuilds its
// verdicts and the trigger-key history from the chain, and the message is still delivered.
export async function restartCatchesUp(m: M3, s: Scenario, rotated: Rotated, strangers: Strangers): Promise<void> {
  const { ctx } = m;
  const d = await startDeposit(ctx, "restart", 40n * ONE);
  await awaitTrigger(ctx, s, d);
  const signer = (await publicClient.getTransaction({ hash: d.triggerTx! })).from;
  s.check("restart: the deposit was triggered by K2, a key that is in the registry history but not the constructor's", same(signer, rotated.address) && !same(signer, ctx.dep.trigger), signer);
  s.check("restart: the message was still undelivered when the relayer was killed", !ctx.watcher.find("Settled", d.depositId));

  writeFileSync(DEAD_NONCES, `${JSON.stringify({ [SENTINEL_NONCE]: { reason: "e2e sentinel", marked_at: new Date().toISOString() } }, null, 2)}\n`);
  const slotBefore = await slot(m);
  const restart = await restartEthereumRelayer(m.log);
  s.time("relayer down until restarted", restart.restartSeconds * 1000);
  s.ref("relayer pid", `${restart.oldPid} -> ${restart.newPid}`);
  s.check("the stack's loop started ethereum-v3 again with a new pid", restart.newPid !== restart.oldPid, `${restart.restartSeconds.toFixed(1)} s`);

  const started = await m.log.waitFor("the getcash filter after the restart", restart.offset, OURS_MODE, undefined, 120_000);
  s.ref("relayer restarted", describeLine(started));
  const loaded = await m.log.waitFor("the dead-nonce store being loaded", restart.offset, "loaded dead-nonce store", undefined, 60_000);
  s.check("the restarted relayer loaded its own dead-nonce file", loaded.fields.count === 1, describeLine(loaded));

  const settled = await awaitSettled(ctx, s, d);
  s.check("restart: the message was delivered after the restart, once", ctx.watcher.all("Settled", d.depositId).length === 1, `Settled{repaid:${settled.args.repaid}}, Asset Hub block ${settled.blockNumber}`);
  s.check("restart: the user holds the payout", (await balanceOf(ctx, d.ss58)) > 0n);
  await oursEvidence(m, s, d.name, d.nonce!, restart.offset);

  const screened = await Promise.all([strangers.a, strangers.b].map((stranger) => m.log.waitFor(`${stranger.name} screened out again`, restart.offset, NOT_OURS, stranger.nonce, 120_000)));
  s.check("the rebuilt verdict cache screens both stranger messages out again", screened.length === 2, screened.map((line) => line.time).join(", "));
  await notOursEvidence(m, s, "4a after restart", strangers.a.nonce, restart.offset);
  await notOursEvidence(m, s, "4b after restart", strangers.b.nonce, restart.offset);

  const dead = existsSync(DEAD_NONCES) ? (JSON.parse(readFileSync(DEAD_NONCES, "utf8")) as Record<string, unknown>) : {};
  const ours = [d.nonce!, strangers.a.nonce, strangers.b.nonce].map(String);
  s.check("the dead-nonce store holds only the sentinel: neither our messages nor the strangers' were dead-lettered", Object.keys(dead).join(",") === SENTINEL_NONCE && !ours.some((nonce) => nonce in dead), Object.keys(dead).join(","));
  rmSync(DEAD_NONCES, { force: true });

  const slotAfter = await waitFor("the beacon light client to advance after the restart", async () => {
    const now = await slot(m);
    return now > slotBefore && now;
  }, 240_000, 5_000);
  s.check("the beacon light client keeps advancing after the restart", slotAfter > slotBefore, `slot ${slotBefore} to ${slotAfter}`);
  m.delivered.push(d);
}

const slot = (m: M3) => finalizedBeaconSlot(m.bridgeHub);
