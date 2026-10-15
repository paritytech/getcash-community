// Live proof of one arrival rule on Paseo: funds a fresh burner from the account PROOF_ENTROPY
// derives, drives the real funding ticks under PROOF_ARRIVAL until the run is done, then keeps
// ticking with People read as empty, as it is once the host has claimed, until the conversion's
// block is final. Spends testnet funds and never runs in CI:
//   ARRIVAL_PROOF=1 PROOF_ENTROPY=0x… PROOF_ARRIVAL=best pnpm vitest run tests/arrival-proof.test.ts

import { describe, expect, it } from "vitest";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { deriveKeypairWithSecret } from "@getsome/ephemeral";
import {
  chooseCashTransfer,
  DEFAULT_INCLUSION_TIMEOUT_MS,
  DEFAULT_SLIPPAGE_PCT,
  DEFAULT_TICK_TIMEOUT_MS,
  discoverPool,
  freshTickState,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  sizeNativeBudget,
  tickOnce,
  type ArrivalRule,
} from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import { estimateFundingSizing } from "../lib/funding-fees";

const SETTLE = BigInt(process.env.PROOF_AMOUNT ?? "10") * 1_000_000n;
const ARRIVAL = (process.env.PROOF_ARRIVAL ?? "best") as ArrivalRule;
const RUN_TIMEOUT_MS = 480_000;
const TICK_MS = 2_000;
const pas = (v: bigint) => (Number(v) / 1e10).toFixed(4);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string) =>
  Uint8Array.from(hex.replace(/^0x/, "").match(/../g) ?? [], (b) => parseInt(b, 16));
const since = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`;

describe.runIf(process.env.ARRIVAL_PROOF === "1")(`arrival proof (${ARRIVAL})`, () => {
  it("drives the real ticks to done, holds done once People is empty, and settles the block final", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      const funder = deriveKeypairWithSecret(fromHex(process.env.PROOF_ENTROPY ?? ""));
      const funderBal = await ah.query.System.Account.getValue(funder.address);
      console.log(`FUNDER ${funder.address}  free=${pas(funderBal?.data?.free ?? 0n)} PAS`);

      const entropy = new Uint8Array(32);
      new TextEncoder().encodeInto(`getcash-arrival-proof-${Date.now()}`, entropy);
      const burner = deriveKeypairWithSecret(entropy);
      console.log(`BURNER ${burner.address}  entropy=${toHex(entropy)}`);

      const transfer = await chooseCashTransfer({
        assetHub: ahC,
        people: peC,
        assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
      });
      const sizing = await estimateFundingSizing({
        ahClient: ahC,
        peopleClient: peC,
        underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
        settleAmount: SETTLE,
        probeAddress: burner.address,
      });
      if (!sizing) throw new Error("sizing failed");
      const budget = await sizeNativeBudget({
        client: ahC,
        underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
        settleAmount: SETTLE,
        remoteFeeBuffer: sizing.remoteFeeBuffer,
        keepNativeForFees: sizing.keepNativeForFees,
      });
      console.log(`DEPOSIT ${pas(budget)} PAS for ${Number(SETTLE) / 1e6} CASH, by ${transfer}`);
      if ((funderBal?.data?.free ?? 0n) < budget + 5_000_000_000n) {
        throw new Error(`fund ${funder.address} with at least ${pas(budget * 2n)} PAS`);
      }

      const started = Date.now();
      const funded = await ah.tx.Balances.transfer_keep_alive({
        dest: { type: "Id", value: burner.address },
        value: budget,
      }).signAndSubmit(funder.signer);
      console.log(`FUNDED block=${funded.block?.number} ok=${funded.ok} at ${since(started)}`);

      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      const state = freshTickState();
      const readPeople = async (ss58: string, at: "best" | "finalized") => {
        const h = await pe.query.Assets.Account.getValue(CASH_LOCATION, ss58, { at });
        return h?.balance ?? 0n;
      };
      // Once done, People is read as empty, as it is once the host has claimed.
      let claimed = false;
      const stamps: Record<string, string> = {};
      const steps: string[] = [];
      let regressed = false;
      let ticks = 0;
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      while (true) {
        if (Date.now() > deadline) throw new Error(`no settlement within ${RUN_TIMEOUT_MS}ms`);
        ticks += 1;
        let step = "?";
        try {
          const best = await ahC.getBestBlocks();
          const outcome = await tickOnce(
            {
              api: ah,
              peopleApi: pe,
              route: { tier: "pool" },
              transfer,
              pool,
              address: burner.address,
              signer: burner.signer,
              beneficiaryHex: toHex(burner.publicKey),
              settleAmount: SETTLE,
              peopleParaId: PASEO_PEOPLE_PARA_ID,
              assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
              remoteFeeBuffer: sizing.remoteFeeBuffer,
              keepNativeForFees: sizing.keepNativeForFees,
              slippagePct: DEFAULT_SLIPPAGE_PCT,
              tickTimeoutMs: DEFAULT_TICK_TIMEOUT_MS,
              inclusionTimeoutMs: DEFAULT_INCLUSION_TIMEOUT_MS,
              signOptions: { at: best[0]?.hash },
              readUnderlyingOnPeople: claimed ? async () => 0n : readPeople,
              arrival: ARRIVAL,
              now: Date.now,
              onTx: (i) => {
                stamps.included ??= since(started);
                console.log(`  TX ${i.call} block=${i.block} at ${since(started)}`);
              },
            },
            state,
          );
          step = outcome.step;
        } catch (e) {
          step = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (steps.at(-1) !== step) {
          steps.push(step);
          stamps[step] ??= since(started);
        }
        if (steps.includes("done") && step !== "done") regressed = true;
        const finalized = await ah.query.System.Number.getValue({ at: "finalized" });
        console.log(
          `  ${since(started)} ${step} xcm=${state.xcmSubmitted} nonce=${state.nonceAtSubmit} block=${state.inclusionBlock} arrived=${state.arrived} finalizedAh=${finalized}${claimed ? " peopleStubbedEmpty" : ""}`,
        );
        if (step === "done" && !claimed) {
          claimed = true;
          stamps.claimedStub = since(started);
        }
        if (step === "done" && state.nonceAtSubmit === null && ticks > 2) {
          stamps.settled = since(started);
          break;
        }
        await sleep(TICK_MS);
      }

      const account = await ah.query.System.Account.getValue(burner.address, { at: "finalized" });
      const peopleCash = await readPeople(burner.address, "best");
      console.log("RESULT");
      console.log(`steps: ${steps.join(" -> ")}`);
      console.log(`stamps: ${JSON.stringify(stamps)}`);
      console.log(
        `burner on AH: nonce=${account.nonce} providers=${account.providers} free=${account.data.free}`,
      );
      console.log(`CASH on People: ${Number(peopleCash) / 1e6}`);
      expect(regressed).toBe(false);
      expect(state).toMatchObject({
        xcmSubmitted: true,
        nonceAtSubmit: null,
        inclusionBlock: null,
        inclusionHash: null,
        arrived: true,
        attempts: 1,
      });
      expect(peopleCash).toBeGreaterThanOrEqual(SETTLE);
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 600_000);
});
