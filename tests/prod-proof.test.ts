// End-to-end production proof: funds a fresh burner from Alice on Paseo and drives the real
// funding ticks against it with real submissions. Spends testnet funds and never runs in CI:
//   PROD_PROOF=1 pnpm vitest run tests/prod-proof.test.ts

import { describe, it } from "vitest";
import { createClient, AccountId } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import {
  createDerive,
  sr25519,
  sr25519Derive,
  entropyToMiniSecret,
  mnemonicToEntropy,
  DEV_PHRASE,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { deriveKeypairWithSecret } from "@getsome/ephemeral";
import {
  DEFAULT_SLIPPAGE_PCT,
  DEFAULT_SUBMIT_TIMEOUT_MS,
  DEFAULT_TICK_TIMEOUT_MS,
  discoverPool,
  freshTickState,
  FundingShortfallError,
  PASEO_ASSET_HUB_PARA_ID,
  PASEO_PEOPLE_PARA_ID,
  PASEO_UNDERLYING_ASSET_ID,
  sizeNativeBudget,
  tickOnce,
} from "@getsome/funding";
import { CASH_LOCATION } from "@getsome/people";
import { estimateFundingSizing } from "../lib/funding-fees";

/** CASH to ask for, whole units; override with PROD_AMOUNT to probe other sizes. */
const SETTLE = BigInt(process.env.PROD_AMOUNT ?? "20") * 1_000_000n;
const RUN_TIMEOUT_MS = 300_000;
const POLL_MS = 3_000;
const pas = (v: bigint) => (Number(v) / 1e10).toFixed(6);
const cash = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

describe.runIf(process.env.PROD_PROOF === "1")("production proof", () => {
  it("funds a fresh burner from Alice and drives the real funding ticks", async () => {
    const ahC = createClient(getWsProvider("wss://paseo-asset-hub-next-rpc.polkadot.io"));
    const peC = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ah: any = ahC.getTypedApi(paseo_next_v2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pe: any = peC.getTypedApi(paseo_people_next);
    try {
      // Alice
      const mini = entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aliceKp = (createDerive as any)({
        seed: mini,
        curve: sr25519,
        derive: sr25519Derive,
      })("//Alice");
      const aliceAddr = AccountId(0).dec(aliceKp.publicKey);
      const aliceSigner = getPolkadotSigner(aliceKp.publicKey, "Sr25519", aliceKp.sign);
      const aliceBal = await ah.query.System.Account.getValue(aliceAddr);
      console.log(`ALICE ${aliceAddr}  free=${pas(aliceBal?.data?.free ?? 0n)} PAS`);

      // Fresh burner per run, entropy logged
      const entropy = new Uint8Array(32);
      new TextEncoder().encodeInto(`getcash-prod-proof-${Date.now()}`, entropy);
      const burner = deriveKeypairWithSecret(entropy);
      console.log(`BURNER ${burner.address}  entropy=${toHex(entropy)}`);

      // Size the deposit as the app does
      const sizing = await estimateFundingSizing({
        ahClient: ahC,
        peopleClient: peC,
        underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
        peopleParaId: PASEO_PEOPLE_PARA_ID,
        settleAmount: SETTLE,
        probeAddress: burner.address,
      });
      if (!sizing) throw new Error("sizing failed");
      console.log(
        `SIZING remoteFeeBuffer=${cash(sizing.remoteFeeBuffer)} CASH  keepNative=${pas(sizing.keepNativeForFees)} PAS`,
      );
      const budget = await sizeNativeBudget({
        client: ahC,
        underlyingAssetId: PASEO_UNDERLYING_ASSET_ID,
        settleAmount: SETTLE,
        remoteFeeBuffer: sizing.remoteFeeBuffer,
        keepNativeForFees: sizing.keepNativeForFees,
      });
      console.log(`DEPOSIT to send: ${pas(budget)} PAS`);

      // Alice funds the burner
      const before = await ah.query.System.Account.getValue(burner.address);
      if ((before?.data?.free ?? 0n) < budget) {
        const xfer = ah.tx.Balances.transfer_keep_alive({
          dest: { type: "Id", value: burner.address },
          value: budget,
        });
        const r = await xfer.signAndSubmit(aliceSigner);
        console.log(`FUNDED burner: ok=${r.ok} block=${r.block?.number} tx=${r.txHash}`);
      } else {
        console.log("burner already funded, skipping transfer");
      }

      // Drive the real ticks, one reading of the world per tick
      const steps: string[] = [];
      const txs: string[] = [];
      const pool = await discoverPool(ah, PASEO_UNDERLYING_ASSET_ID);
      const state = freshTickState();
      const readUnderlyingOnPeople = async (ss58: string) => {
        const h = await pe.query.Assets.Account.getValue(CASH_LOCATION, ss58);
        return h?.balance ?? 0n;
      };
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let step = "";
      while (step !== "done") {
        if (Date.now() > deadline) throw new Error(`no completion within ${RUN_TIMEOUT_MS}ms`);
        let submitted = false;
        try {
          const best = await ahC.getBestBlocks();
          const outcome = await tickOnce(
            {
              api: ah,
              peopleApi: pe,
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
              submitTimeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS,
              signOptions: { at: best[0]?.hash },
              readUnderlyingOnPeople,
              now: Date.now,
              onTx: (i) => {
                txs.push(`${i.call}@${i.block ?? "?"}`);
                console.log(`  TX ${i.call} block=${i.block} hash=${i.txHash}`);
              },
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
          if (e instanceof FundingShortfallError) throw e;
          console.log(`  tick failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (step !== "done" && !submitted) await sleep(POLL_MS);
      }

      // Results
      const peopleCash = await pe.query.Assets.Account.getValue(CASH_LOCATION, burner.address);
      const ahNative = await ah.query.System.Account.getValue(burner.address);
      const ahCash = await ah.query.Assets.Account.getValue(
        PASEO_UNDERLYING_ASSET_ID,
        burner.address,
      );
      const landed = peopleCash?.balance ?? 0n;
      console.log("RESULT");
      console.log(`steps: ${steps.join(" -> ")}`);
      console.log(`txs:   ${txs.join(", ")}`);
      console.log(`ASKED:            ${cash(SETTLE)} CASH`);
      console.log(`LANDED on People: ${cash(landed)} CASH   ${landed >= SETTLE ? "ok" : "SHORT"}`);
      // Raw base units: PAS has 10 decimals and a formatted figure can hide planck-level dust.
      const leftNative = ahNative?.data?.free ?? 0n;
      const leftCash = ahCash?.balance ?? 0n;
      console.log(
        `leftover on AH:   ${leftNative} planck (${pas(leftNative)} PAS), ${leftCash} base units (${cash(leftCash)} CASH)`,
      );
      console.log(
        `burner truly empty: ${leftNative === 0n && leftCash === 0n ? "yes, 0 and 0" : "NO"}`,
      );
    } finally {
      ahC.destroy();
      peC.destroy();
    }
  }, 600_000);
});
