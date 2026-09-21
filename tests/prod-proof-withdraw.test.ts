// End-to-end production proof of the withdrawal chain legs: drives the real withdrawal ticks for
// a burner that holds CASH on People, sending the PAS to Alice on Asset Hub. The on-ramp production
// proof funds such a burner and prints its label. Spends testnet funds and never runs in CI:
//   PROD_PROOF_WITHDRAW=1 WITHDRAW_BURNER=getcash-prod-proof-<ms> pnpm vitest run tests/prod-proof-withdraw.test.ts

import { describe, it } from "vitest";
import { AccountId, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { deriveKeypairWithSecret } from "@getsome/ephemeral";
import { PASEO_ASSET_HUB_PARA_ID, PASEO_PEOPLE_PARA_ID } from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import {
  readDestinationPas,
  DEFAULT_WITHDRAW_SLIPPAGE_PCT,
  DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
  DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
  freshWithdrawTickState,
  PASEO_PEOPLE_POOL_ACCOUNT,
  withdrawTickOnce,
  WithdrawRejectedError,
} from "@getsome/withdraw";

const cash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const pas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const toHex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ALICE = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const BURNER_LABEL = process.env.WITHDRAW_BURNER;
const RUN_TIMEOUT_MS = 300_000;
const POLL_MS = 4_000;

describe.runIf(process.env.PROD_PROOF_WITHDRAW === "1")("withdrawal production proof", () => {
  it("moves a burner's CASH on People to Alice on Asset Hub as PAS", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    const assetHubApi = ahC.getTypedApi(paseo_next_v2);
    const peopleApi = peC.getTypedApi(paseo_people_next);
    try {
      if (!BURNER_LABEL) throw new Error("set WITHDRAW_BURNER to a burner label holding CASH");
      const entropy = new Uint8Array(32);
      new TextEncoder().encodeInto(BURNER_LABEL, entropy);
      const key = deriveKeypairWithSecret(entropy);
      const readCash = async (ss58: string) =>
        (await peopleApi.query.Assets.Account.getValue(CASH_LOCATION as never, ss58))?.balance ??
        0n;
      const readPas = async (ss58: string) =>
        (await peopleApi.query.System.Account.getValue(ss58))?.data?.free ?? 0n;
      const aliceBefore = (await assetHubApi.query.System.Account.getValue(ALICE)).data.free;
      console.log(
        `KEY ${key.address}: ${cash(await readCash(key.address))} CASH, ${pas(await readPas(key.address))} PAS on People`,
      );
      console.log(`ALICE on Asset Hub before: ${pas(aliceBefore)} PAS`);

      const state = freshWithdrawTickState();
      const steps: string[] = [];
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let step = "";
      while (step !== "done") {
        if (Date.now() > deadline) throw new Error(`no completion within ${RUN_TIMEOUT_MS}ms`);
        let submitted = false;
        try {
          const outcome = await withdrawTickOnce(
            {
              peopleApi,
              assetHubApi,
              key: { address: key.address, publicKeyHex: toHex(key.publicKey), signer: key.signer },
              destinationHex: toHex(AccountId().enc(ALICE)),
              assetHubParaId: PASEO_ASSET_HUB_PARA_ID,
              peopleParaId: PASEO_PEOPLE_PARA_ID,
              poolAccount: PASEO_PEOPLE_POOL_ACCOUNT,
              slippagePct: DEFAULT_WITHDRAW_SLIPPAGE_PCT,
              tickTimeoutMs: DEFAULT_WITHDRAW_TICK_TIMEOUT_MS,
              submitTimeoutMs: DEFAULT_WITHDRAW_SUBMIT_TIMEOUT_MS,
              readKeyOnPeople: async (ss58) => ({
                cash: await readCash(ss58),
                pas: await readPas(ss58),
              }),
              readDestinationOnAssetHub: (hex) => readDestinationPas(assetHubApi, hex),
              now: Date.now,
              onTx: (i) => console.log(`  TX ${i.call} block=${i.block} hash=${i.txHash}`),
              onTransientError: (e) =>
                console.log(`  transient: ${e instanceof Error ? e.message : String(e)}`),
            },
            state,
          );
          submitted = outcome.submitted;
          if (outcome.step !== step) {
            step = outcome.step;
            steps.push(step);
            console.log(`  STEP -> ${step}`);
          }
        } catch (e) {
          if (e instanceof WithdrawRejectedError) throw e;
          console.log(`  tick failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (step !== "done" && !submitted) await sleep(POLL_MS);
      }

      const aliceAfter = (await assetHubApi.query.System.Account.getValue(ALICE)).data.free;
      const keyCash = await readCash(key.address);
      const keyPas = await readPas(key.address);
      console.log("RESULT");
      console.log(`steps: ${steps.join(" -> ")}`);
      console.log(`expected landing: ${state.expectedLanding}`);
      console.log(`ALICE gained: ${pas(aliceAfter - aliceBefore)} PAS`);
      console.log(`key left with: ${keyCash} CASH units, ${keyPas} planck on People`);
      // The PAS reserve's unspent part is below the existential deposit and reaped, so both read
      // zero once the account is gone.
      console.log(`key truly empty: ${keyCash === 0n && keyPas === 0n ? "yes, 0 and 0" : "NO"}`);
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 600_000);
});
