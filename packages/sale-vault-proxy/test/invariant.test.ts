import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import fc from "fast-check";
import type { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import {
  SRC_ADDR,
  SRC_CHAIN,
  TEST_NETWORK,
  claimerOf,
  deliver,
  deploySystem,
  encodeMessage,
  homeOf,
  refOf,
  type System,
} from "./helpers";
import { deferFloor, intrinsicGas, mockRig, receive } from "./measure";

const HOMES = ["a", "b"].map(homeOf);
const CLAIMERS = ["a", "b"].map(claimerOf);
const REFS = ["r0", "r1", "r2"].map(refOf);
const PAYEES = [
  "0x00000000000000000000000000000000000ca5e1",
  "0x00000000000000000000000000000000000ca5e2",
].map((a) => ethers.getAddress(a));
const COMMITTED = [5_000_000n, 30_000_000n];
// A sale's payment window, under the release wait so a wait expires a deferred sale
const WINDOW = 3_600n;
const SALE_KINDS = ["full", "over", "short", "blocked", "frozen", "lowgas", "late", "dirty"];

// A delivery picks its terms from small pools so the same terms repeat across a run
const pick = {
  home: fc.nat({ max: 1 }),
  claimer: fc.nat({ max: 1 }),
  ref: fc.nat({ max: 2 }),
  payee: fc.nat({ max: 1 }),
  committed: fc.nat({ max: 1 }),
};
const sale = fc.record({
  kind: fc.constantFrom(...SALE_KINDS),
  ...pick,
  extra: fc.bigInt({ min: 0n, max: 25_000_000n }),
});
const other = fc.record({
  kind: fc.constantFrom(
    "deliver",
    "expire",
    "donate",
    "return",
    "kill",
    "release",
    "flush",
    "fallback",
    "skim",
    "retire",
    "wait",
    "stale",
  ),
  ...pick,
  extra: fc.bigInt({ min: 1n, max: 25_000_000n }),
});

const op = (kind: string, ref: number) => ({
  kind,
  home: 0,
  claimer: 0,
  ref,
  payee: 0,
  committed: 0,
  extra: 1n,
});
const COVERING_RUN = [
  op("lowgas", 0),
  op("deliver", 0),
  op("late", 1),
  op("full", 2),
  op("lowgas", 1),
  op("wait", 0),
  op("expire", 1),
  op("fallback", 0),
  op("release", 0),
];

type Terms = [string, string, string, string, bigint, bigint];

interface Ledger {
  in: bigint;
  paid: bigint;
  returned: bigint;
  released: bigint;
  lastReturn: bigint;
}

async function attempt(p: Promise<ContractTransactionResponse>) {
  try {
    return await (await p).wait();
  } catch {
    return null;
  }
}

describe("invariants (property)", () => {
  let floor: bigint;
  before(async () => {
    floor = await deferFloor(mockRig(await loadFixture(deploySystem)));
  });

  it("conserve USDC, pay each sale at most once and never late, keep totalPending exact and release only to the claimer", async () => {
    // Counts across runs, so the property is shown to reach every path
    const seen = { paid: 0, delivered: 0, expired: 0, expireDeferred: 0, released: 0, fallback: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(sale, other), { minLength: 1, maxLength: 16 }),
        async (ops) => {
          const s: System = await loadFixture(deploySystem);
          const rig = mockRig(s);
          const usdc = await s.usdc.getAddress();
          const factory = await s.factory.getAddress();
          const vault = await s.vault.getAddress();
          // Proxy i is home i >> 1 with claimer i & 1
          const pairs = HOMES.flatMap((h) => CLAIMERS.map((c) => [h, c] as const));
          const proxies = await Promise.all(pairs.map(([h, c]) => s.factory.predict(h, c)));
          const ledgers: Ledger[] = proxies.map(() => ({
            in: 0n,
            paid: 0n,
            returned: 0n,
            released: 0n,
            lastReturn: 0n,
          }));
          const transfers = s.usdc.interface.getEvent("Transfer");
          const proxyIface = s.implementation.interface;
          const factoryIface = s.factory.interface;
          const paidTopic = proxyIface.getEvent("SalePaid").topicHash;
          const heldTopic = proxyIface.getEvent("SaleHeld").topicHash;
          const deferredTopic = factoryIface.getEvent("DeliveryDeferred").topicHash;
          const paidTerms = new Map<string, number>();
          // Every deferred entry this run, so deliver and expire mostly hit a real one
          const deferred = new Map<string, Terms>();
          const known = [factory, vault, s.treasury.address, ...proxies, ...PAYEES, ...CLAIMERS];

          for (const o of ops) {
            const i = o.home * 2 + o.claimer;
            const [home, claimer] = pairs[i];
            const proxyAddress = proxies[i];
            const proxy = await ethers.getContractAt("SaleVaultProxy", proxyAddress);
            const ref = REFS[o.ref];
            const payee = PAYEES[o.payee];
            const c = COMMITTED[o.committed];
            const entries = [...deferred.values()];
            const entry: Terms = entries.length
              ? entries[o.ref % entries.length]
              : [home, claimer, ref, payee, c, 0n];
            let receipt: ContractTransactionReceipt | null = null;
            // The deadline this op's delivery is judged by, none when it delivers nothing
            let deadline: bigint | undefined;
            if (SALE_KINDS.includes(o.kind)) {
              const amount = o.kind === "short" ? c / 2n : o.kind === "over" ? c + o.extra : c;
              const now = BigInt(await time.latest());
              deadline = o.kind === "late" ? now - 1n : now + WINDOW;
              let msg = encodeMessage(ref, payee, c, home, deadline, claimer);
              // A claimer word with a dirty high byte, never booked to any proxy
              if (o.kind === "dirty")
                msg = ethers.concat([
                  ethers.dataSlice(msg, 0, 160),
                  "0x01",
                  ethers.dataSlice(msg, 161),
                ]);
              if (o.kind === "blocked") await s.usdc.setBlocked(payee, true);
              if (o.kind === "frozen") await s.usdc.setBlocked(proxyAddress, true);
              if (o.kind === "lowgas") {
                const data = factoryIface.encodeFunctionData("cfReceive", [
                  SRC_CHAIN,
                  SRC_ADDR,
                  msg,
                  usdc,
                  amount,
                ]);
                receipt = await attempt(
                  receive(rig, msg, amount, intrinsicGas(data) + floor + 5_000n),
                );
                if (receipt?.logs.some((l) => l.topics[0] === deferredTopic)) {
                  const t: Terms = [home, claimer, ref, payee, c, deadline];
                  deferred.set(t.join(":"), t);
                }
              } else {
                receipt = await attempt(deliver(s, msg, amount));
              }
              await s.usdc.setBlocked(payee, false);
              await s.usdc.setBlocked(proxyAddress, false);
            } else if (o.kind === "deliver") {
              receipt = await attempt(s.factory.deliver(...entry));
              if (receipt) {
                seen.delivered++;
                deadline = entry[5];
              }
            } else if (o.kind === "expire") {
              receipt = await attempt(s.factory.expireDeferred(...entry));
              if (receipt) {
                seen.expireDeferred++;
                expect(BigInt((await receipt.getBlock()).timestamp) > entry[5]).to.equal(true);
              }
            } else if (o.kind === "donate") {
              receipt = await attempt(s.usdc.mint(proxyAddress, o.extra));
            } else if (o.kind === "return") {
              receipt = await attempt(proxy.returnHome());
              // A codeless proxy accepts the call as a no-op, so only a ReturnedHome counts
              for (const log of receipt?.logs ?? []) {
                const parsed = log.address === proxyAddress ? proxyIface.parseLog(log) : null;
                if (parsed?.name !== "ReturnedHome") continue;
                expect(await s.factory.retired()).to.equal(false);
                ledgers[i].lastReturn = parsed.args.amount;
                const rest = await s.usdc.balanceOf(proxyAddress);
                expect(rest === 0n || rest >= TEST_NETWORK.minReturn).to.equal(true);
              }
            } else if (o.kind === "kill") {
              const back = ledgers[i].lastReturn;
              ledgers[i].lastReturn = 0n;
              if (back > 0n) receipt = await attempt(s.vault.refund(usdc, proxyAddress, back));
            } else if (o.kind === "release") {
              receipt = await attempt(proxy.release());
            } else if (o.kind === "flush") {
              receipt = await attempt(s.factory.flush(home, claimer));
            } else if (o.kind === "fallback") {
              await s.usdc.setBlocked(proxyAddress, true);
              receipt = await attempt(s.factory.flush(home, claimer));
              await s.usdc.setBlocked(proxyAddress, false);
            } else if (o.kind === "skim") {
              receipt = await attempt(s.factory.skim());
            } else if (o.kind === "retire") {
              receipt = await attempt(s.factory.connect(s.guardian).retire());
            } else {
              await time.increase(
                o.kind === "wait" ? TEST_NETWORK.releaseDelay : TEST_NETWORK.staleDelay,
              );
            }

            // totalPending is exactly every pending credit plus every deferred entry, on every path
            let sum = 0n;
            for (const [h, cl] of pairs) sum += await s.factory.pending(h, cl);
            for (const t of deferred.values()) sum += await s.factory.pendingDelivery(...t);
            expect(await s.factory.totalPending()).to.equal(sum);
            expect((await s.usdc.balanceOf(factory)) >= sum).to.equal(true);

            if (!receipt) continue;
            const at = BigInt((await receipt.getBlock()).timestamp);
            for (const log of receipt.logs) {
              if (log.topics[0] === heldTopic) {
                const parsed = proxyIface.parseLog(log);
                if (parsed?.args.reason === ethers.encodeBytes32String("expired")) seen.expired++;
                continue;
              }
              if (log.topics[0] === paidTopic) {
                // A sale is only ever paid inside its payment window
                expect(deadline !== undefined && at <= deadline).to.equal(true);
                const k = proxies.indexOf(ethers.getAddress(log.address));
                const parsed = proxyIface.parseLog(log);
                if (k < 0 || !parsed) continue;
                const key = `${k}:${parsed.args.ref}:${parsed.args.recipient}:${parsed.args.committed}`;
                paidTerms.set(key, (paidTerms.get(key) ?? 0) + 1);
                seen.paid++;
                continue;
              }
              if (log.address !== usdc || log.topics[0] !== transfers.topicHash) continue;
              const from = ethers.getAddress(ethers.dataSlice(log.topics[1], 12));
              const to = ethers.getAddress(ethers.dataSlice(log.topics[2], 12));
              const value = BigInt(log.data);
              const into = proxies.indexOf(to);
              if (into >= 0) ledgers[into].in += value;
              if (from === factory && CLAIMERS.includes(to)) {
                // A flush fallback pays only the claimer of the credit it flushed
                expect(o.kind).to.equal("fallback");
                expect(to).to.equal(claimer);
                seen.fallback++;
              }
              const out = proxies.indexOf(from);
              if (out < 0) continue;
              if (to === vault) ledgers[out].returned += value;
              else if (to === pairs[out][1]) {
                ledgers[out].released += value;
                seen.released++;
              } else {
                // A proxy pays out only to a sale's recipient, never the factory or treasury
                expect(PAYEES).to.include(to);
                ledgers[out].paid += value;
              }
            }
          }

          for (let k = 0; k < proxies.length; k++) {
            const l = ledgers[k];
            const balance = await s.usdc.balanceOf(proxies[k]);
            expect(l.in).to.equal(l.paid + l.returned + l.released + balance);
          }
          // Every USDC minted sits with a known party, none is created or lost
          let held = 0n;
          for (const who of known) held += await s.usdc.balanceOf(who);
          expect(held).to.equal(await s.usdc.totalSupply());
          for (const count of paidTerms.values()) expect(count).to.equal(1);
          return true;
        },
      ),
      // A fixed run that always reaches a pay, a replay, an expiry, a fallback and a release
      { numRuns: 40, examples: [[COVERING_RUN]] },
    );
    for (const [path, count] of Object.entries(seen)) {
      expect(count, path).to.be.greaterThan(0);
    }
  });
});
