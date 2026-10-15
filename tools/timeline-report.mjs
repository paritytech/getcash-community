// Turns an iOS host log of top-up runs into one timeline per run, with each step's block, the
// block's own time, when the device saw it and when the head recorder saw it.
// usage: node tools/timeline-report.mjs (--log <file> | --latest) [--heads <jsonl>] [--since HH:MM]
//        [--ah <wss>] [--people <wss>] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import network from "../packages/core/src/network.json" with { type: "json" };

const AH_RPC = "wss://paseo-asset-hub-next-rpc.polkadot.io";
const PEOPLE_RPC = "wss://paseo-people-next-system-rpc.polkadot.io";
const TIMESTAMP_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
const CASH_ASSET_HUB_ID = 50000413;
const CASH_ON_PEOPLE = {
  parents: 1,
  interior: {
    type: "X3",
    value: [
      { type: "Parachain", value: network.assetHub.paraId },
      { type: "PalletInstance", value: 50 },
      { type: "GeneralIndex", value: BigInt(CASH_ASSET_HUB_ID) },
    ],
  },
};
const NONE = "–";

// Log lines

const LINE = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) \S+ (\S+) - (.*)$/;
const KEY = /"key": SubstrateSdk\.JSON\.stringValue\("([^"]*)"\)/;
const VALUE = /"value": SubstrateSdk\.JSON\.stringValue\("0x([0-9a-fA-F]*)"\)/;
const TAG = /"tag": SubstrateSdk\.JSON\.stringValue\("(\w+)"\)/;
const FINAL = /"finalized": SubstrateSdk\.JSON\.boolValue\((true|false)\)/;
const HEAD = /^\(([^)]*?):wss?:\/\/[^)]*\) Did receive text: /;
const NUMBER = /"number":"0x([0-9a-fA-F]+)"/;
const TX_STATUS =
  /extrinsicHash: "(0x[0-9a-f]+)".*RemoteExtrinsicStatus\.(inBlock|finalized)\("(0x[0-9a-f]+)"\)/;
const REQUEST_KEY = /^getsome:request:([^:]+):(\d+)$/;

function parseArgs(argv) {
  const opts = {
    log: null,
    latest: false,
    heads: null,
    since: null,
    ah: AH_RPC,
    people: PEOPLE_RPC,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--log") opts.log = next();
    else if (arg === "--latest") opts.latest = true;
    else if (arg === "--heads") opts.heads = next();
    else if (arg === "--since") opts.since = next();
    else if (arg === "--ah") opts.ah = next();
    else if (arg === "--people") opts.people = next();
    else if (arg === "--json") opts.json = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (opts.latest) opts.log = latestLog();
  if (!opts.log)
    throw new Error(
      "usage: timeline-report.mjs (--log <file> | --latest) [--heads <jsonl>] [--since HH:MM]",
    );
  return opts;
}

function latestLog() {
  const root = path.join(os.homedir(), "Library/Developer/CoreSimulator/Devices");
  let best = null;
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 11) walk(full, depth + 1);
      else if (entry.isFile() && full.includes("/Logs/App/") && full.endsWith(".log")) {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(root, 0);
  if (!best) throw new Error("no simulator app log found");
  return best.file;
}

function fileDate(file) {
  const m = path.basename(file).match(/^(\d{4})_(\d\d)_(\d\d)_\d\d_\d\d_\d\d\.log$/);
  if (!m) return new Date(fs.statSync(file).mtime).setHours(0, 0, 0, 0);
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

const decode = (hex) => {
  try {
    return JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
  } catch {
    return undefined;
  }
};

async function readLog(file) {
  const store = {
    jobs: new Map(),
    requests: new Map(),
    updates: [],
    txStatus: [],
    heads: { "Asset Hub": { best: [], final: [] }, People: { best: [], final: [] } },
  };
  let day = fileDate(file);
  let prev = -1;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const m = LINE.exec(line);
    if (!m) continue;
    const clock = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    if (prev >= 0 && clock < prev - 43200000) day += 86400000;
    prev = clock;
    const t = day + clock;
    const source = m[5];
    const msg = m[6];
    if (source.startsWith("ContainerBridge.handleRequest") && msg.includes('"localStorageWrite"')) {
      const k = KEY.exec(msg);
      const v = VALUE.exec(msg);
      if (!k || !v) continue;
      const key = k[1];
      if (key === "getsome.funding.jobs") {
        const jobs = decode(v[1]);
        if (!jobs || typeof jobs !== "object") continue;
        for (const [sid, job] of Object.entries(jobs)) noteJob(store, t, sid, job);
      } else if (REQUEST_KEY.test(key)) {
        const rec = decode(v[1]);
        if (rec && typeof rec === "object") noteRequest(store, t, key, rec);
      }
    } else if (source.startsWith("ContainerBridge.handleSubscribe") && TAG.test(msg)) {
      const tag = TAG.exec(msg)[1];
      const fin = FINAL.exec(msg);
      if (tag === "Claimed") store.updates.push({ t, finalized: fin ? fin[1] === "true" : null });
    } else if (source.startsWith("DurableTxTracker.handle")) {
      const s = TX_STATUS.exec(msg);
      if (s) store.txStatus.push({ t, txHash: s[1], kind: s[2], blockHash: s[3] });
    } else if (source.startsWith("WebSocketEngine+Delegate.handleTextEvent")) {
      const h = HEAD.exec(msg);
      if (!h) continue;
      const kind = msg.includes('"method":"chain_newHead"')
        ? "best"
        : msg.includes('"method":"chain_finalizedHead"')
          ? "final"
          : null;
      const n = NUMBER.exec(msg);
      if (!kind || !n) continue;
      const chain = h[1].endsWith("Asset Hub")
        ? "Asset Hub"
        : h[1].endsWith("People")
          ? "People"
          : null;
      if (chain) store.heads[chain][kind].push([t, parseInt(n[1], 16)]);
    }
  }
  return store;
}

function noteJob(store, t, sid, job) {
  const id = `${sid}@${job.createdAt ?? ""}`;
  let run = store.jobs.get(id);
  if (!run) {
    run = {
      sessionId: sid,
      createdAt: job.createdAt ?? null,
      burner: job.burnerAddress ?? null,
      first: t,
      doneAt: null,
      registeredAt: null,
      submittingAt: null,
    };
    store.jobs.set(id, run);
  }
  if (job.burnerAddress) run.burner = job.burnerAddress;
  if (job.submitting && run.submittingAt === null) run.submittingAt = t;
  if (job.done === true && run.doneAt === null) run.doneAt = t;
  if (job.claim?.registeredAt != null && run.registeredAt === null) run.registeredAt = t;
}

function noteRequest(store, t, key, rec) {
  const burner = rec.handoff?.burnerAddress ?? rec.depositAddress ?? null;
  const id = `${key}@${burner ?? ""}`;
  let r = store.requests.get(id);
  if (!r) {
    r = { key, burner, first: t, seenAt: null, creditedAt: null, last: null };
    store.requests.set(id, r);
  }
  const status = typeof rec.status === "object" && rec.status ? rec.status.kind : rec.status;
  if (status === "deposit-seen" && r.seenAt === null) r.seenAt = t;
  if (rec.creditedAt != null && r.creditedAt === null) r.creditedAt = t;
  r.last = rec;
}

// Head recorder

function readHeads(file) {
  const heads = { "asset-hub": { best: [], final: [] }, people: { best: [], final: [] } };
  if (!file) return null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if ((e.kind === "best" || e.kind === "final") && heads[e.chain])
      heads[e.chain][e.kind].push([e.t, e.number]);
  }
  return heads;
}

const seenAtOrPast = (list, number) =>
  number == null ? null : (list.find(([, n]) => n >= number)?.[0] ?? null);
const headAt = (list, t) => (t == null ? null : (list.findLast((e) => e[0] <= t)?.[1] ?? null));

// Chain

function rpc(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  const call = async (method, params) => {
    await ready;
    const id = next++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };
  const hashOf = (number) => call("chain_getBlockHash", [number]);
  const numberOf = async (hash) => parseInt((await call("chain_getHeader", [hash])).number, 16);
  const timeAt = async (hash) => {
    const raw = await call("state_getStorage", [TIMESTAMP_KEY, hash]);
    return raw ? Number(Buffer.from(raw.slice(2), "hex").readBigUInt64LE(0)) : null;
  };
  const storageAt = (key, hash) => call("state_getStorage", [key, hash]);
  return { call, hashOf, numberOf, timeAt, storageAt, close: () => ws.close() };
}

/** The first block, searching back from `from`, whose state holds `key`; null when `from` does
 *  not hold it. */
async function firstBlockHolding(chain, key, from, back) {
  let last = null;
  for (let n = from; n > from - back; n -= 1) {
    const hash = await chain.hashOf(n);
    if (!hash) break;
    const value = await chain.storageAt(key, hash);
    if (value == null) break;
    last = { number: n, hash };
  }
  return last;
}

/** The first block at or after `from` whose state holds `key`, within `ahead` blocks. */
async function firstBlockAppearing(chain, key, from, ahead) {
  for (let n = from; n < from + ahead; n += 1) {
    const hash = await chain.hashOf(n);
    if (!hash) return null;
    const value = await chain.storageAt(key, hash);
    if (value != null) return { number: n, hash };
  }
  return null;
}

// Runs

function pairRuns(store, since) {
  const jobs = [...store.jobs.values()].filter((j) => j.burner).sort((a, b) => a.first - b.first);
  const requests = [...store.requests.values()];
  const runs = [];
  for (const job of jobs) {
    const req = requests.find((r) => r.burner === job.burner);
    if (!req?.last?.converted || !req.last.depositInBlock) continue;
    if (since != null && job.first < since) continue;
    runs.push({ job, req: req.last, seenAt: req.seenAt, creditedAt: req.creditedAt });
  }
  // Host claim words and top-up transactions go to the run whose claim was registered last.
  runs.sort((a, b) => a.job.first - b.job.first);
  for (const [i, run] of runs.entries()) {
    const from = run.req.claimRegisteredAt ?? run.job.registeredAt ?? Infinity;
    const to = runs[i + 1]?.req.claimRegisteredAt ?? Infinity;
    const inWindow = (e) => e.t >= from - 1000 && e.t < to;
    run.hostClaimed = store.updates.find((u) => inWindow(u) && u.finalized === false)?.t ?? null;
    run.hostClaimedFinal =
      store.updates.find((u) => inWindow(u) && u.finalized === true)?.t ?? null;
    run.topUpInBlock = store.txStatus.find((s) => inWindow(s) && s.kind === "inBlock") ?? null;
    run.topUpFinal = store.txStatus.find((s) => inWindow(s) && s.kind === "finalized") ?? null;
  }
  return runs;
}

async function enrich(run, ah, people, keys, heads, hostHeads) {
  const r = run.req;
  const burner = run.job.burner;
  const out = { burner, steps: [] };
  const t0 = r.observedAt?.["on-burner"] ?? run.seenAt;
  const step = (name, fields) => out.steps.push({ name, ...fields });

  // 1. The deposit on Asset Hub, in the first block holding the burner.
  const seenBlock = r.depositInBlock.block;
  const deposit = await firstBlockHolding(ah, keys.ahAccount(burner), seenBlock, 12);
  const depositTime = deposit ? await ah.timeAt(deposit.hash) : null;
  step("Deposit in a best block on Asset Hub", {
    block: deposit?.number ?? seenBlock,
    chainTime: depositTime,
    deviceTime: t0,
    recorderTime: seenAtOrPast(heads?.["asset-hub"].best ?? [], deposit?.number),
    note: deposit && deposit.number !== seenBlock ? `the worker saw it at ${seenBlock}` : null,
  });
  // 2. That block final.
  step("Deposit block final", {
    block: deposit?.number ?? seenBlock,
    deviceTime: r.observedAt?.["final-on-burner"] ?? null,
    hostHeadTime: seenAtOrPast(hostHeads["Asset Hub"].final, deposit?.number ?? seenBlock),
    recorderTime: seenAtOrPast(heads?.["asset-hub"].final ?? [], deposit?.number ?? seenBlock),
  });
  // 3. Swap submitted.
  step("Swap submitted by the worker", {
    deviceTime: r.conversionPreparedAt ?? run.job.submittingAt,
  });
  // 4. Swap in a block, the XCM sent with it.
  const swapHash = await ah.hashOf(r.converted.block);
  step("Swap in a block, XCM sent", {
    block: r.converted.block,
    chainTime: swapHash ? await ah.timeAt(swapHash) : null,
    deviceTime: r.converted.at,
    recorderTime: seenAtOrPast(heads?.["asset-hub"].best ?? [], r.converted.block),
  });
  // 5. Swap block final.
  step("Swap block final", {
    block: r.converted.block,
    hostHeadTime: seenAtOrPast(hostHeads["Asset Hub"].final, r.converted.block),
    recorderTime: seenAtOrPast(heads?.["asset-hub"].final ?? [], r.converted.block),
  });
  // 6. The XCM executed on People: the first People block holding the burner's CASH.
  const peopleFrom = headAt(heads?.people.best ?? hostHeads.People.best, r.converted.at) ?? null;
  const arrival =
    peopleFrom === null
      ? null
      : await firstBlockAppearing(people, keys.peopleCash(burner), peopleFrom, 60);
  step("XCM received and executed on People, CASH on the account", {
    block: arrival?.number ?? null,
    chainTime: arrival ? await people.timeAt(arrival.hash) : null,
    hostHeadTime: seenAtOrPast(hostHeads.People.best, arrival?.number),
    recorderTime: seenAtOrPast(heads?.people.best ?? [], arrival?.number),
  });
  // 7. That People block final.
  step("People block final", {
    block: arrival?.number ?? null,
    hostHeadTime: seenAtOrPast(hostHeads.People.final, arrival?.number),
    recorderTime: seenAtOrPast(heads?.people.final ?? [], arrival?.number),
  });
  // 8. The worker sees it and registers the claim.
  step("Worker sees the CASH and registers the top-up", {
    deviceTime: r.claimRegisteredAt ?? run.job.registeredAt,
  });
  // 9. Top-up in a block on People.
  const topUpBlock = run.topUpInBlock
    ? await people.numberOf(run.topUpInBlock.blockHash).catch(() => null)
    : null;
  step("Top-up in a block on People", {
    block: topUpBlock,
    chainTime: run.topUpInBlock
      ? await people.timeAt(run.topUpInBlock.blockHash).catch(() => null)
      : null,
    deviceTime: run.topUpInBlock?.t ?? run.hostClaimed,
    recorderTime: seenAtOrPast(heads?.people.best ?? [], topUpBlock),
  });
  // 10. The host says claimed, the purse shows the credit.
  step("Host reports the top-up claimed, purse shows the credit", {
    deviceTime: run.hostClaimed ?? r.creditedAt ?? run.creditedAt,
  });
  // 11. Top-up block final.
  step("Top-up block final", {
    block: topUpBlock,
    deviceTime: run.hostClaimedFinal ?? run.topUpFinal?.t ?? null,
    hostHeadTime: seenAtOrPast(hostHeads.People.final, topUpBlock),
    recorderTime: seenAtOrPast(heads?.people.final ?? [], topUpBlock),
  });
  out.t0 = t0;
  return out;
}

// Output

const clock = (t) =>
  t == null
    ? NONE
    : new Date(t).toTimeString().slice(0, 8) +
      "." +
      String(t % 1000)
        .padStart(3, "0")
        .slice(0, 1);
const since = (t0, t) => (t == null || t0 == null ? NONE : ((t - t0) / 1000).toFixed(1));
const row = (cells) => `| ${cells.join(" | ")} |`;

function markdown(runs) {
  const out = [
    "Times are this Mac's clock. Block time is the chain's own clock, which each chain sets apart from this Mac's by several seconds, so it only measures gaps between blocks of the same chain. Device is when the app saw the step; Recorder is when the head recorder on this Mac saw the block.",
    "",
  ];
  runs.forEach((run, i) => {
    out.push(`## Run ${i + 1}, deposit seen ${clock(run.t0)}, burner ${run.burner}`, "");
    out.push(row(["Step", "Block", "Block time", "Device", "Recorder", "+s device", "+s block"]));
    out.push(row(["---", "---", "---", "---", "---", "---", "---"]));
    for (const s of run.steps) {
      const device = s.deviceTime ?? s.hostHeadTime ?? null;
      out.push(
        row([
          s.name + (s.note ? ` (${s.note})` : ""),
          s.block ?? NONE,
          clock(s.chainTime),
          clock(device),
          clock(s.recorderTime),
          since(run.t0, device),
          since(run.t0, s.chainTime ?? s.recorderTime),
        ]),
      );
    }
    out.push("");
  });
  // Medians of the gaps between the device times of the steps.
  const names = runs[0]?.steps.map((s) => s.name) ?? [];
  const gaps = names.map((_, i) =>
    runs.map((run) => {
      const s = run.steps[i];
      const t = s.deviceTime ?? s.hostHeadTime ?? s.recorderTime ?? s.chainTime ?? null;
      return t == null ? null : (t - run.t0) / 1000;
    }),
  );
  out.push("## Median since the deposit was seen, device clock", "");
  out.push(row(["Step", "Median s", "Min", "Max", "Runs"]));
  out.push(row(["---", "---", "---", "---", "---"]));
  names.forEach((name, i) => {
    const v = gaps[i].filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return out.push(row([name, NONE, NONE, NONE, 0]));
    const mid = v.length >> 1;
    const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    out.push(row([name, median.toFixed(1), v[0].toFixed(1), v[v.length - 1].toFixed(1), v.length]));
  });
  return out.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const store = await readLog(opts.log);
  for (const chain of Object.values(store.heads))
    for (const k of ["best", "final"]) chain[k].sort((a, b) => a[0] - b[0]);
  const heads = readHeads(opts.heads);
  let sinceMs = null;
  if (opts.since) {
    const [h, m] = opts.since.split(":").map(Number);
    sinceMs = fileDate(opts.log) + (h * 60 + m) * 60000;
  }
  const runs = pairRuns(store, sinceMs);
  const ahClient = createClient(getWsProvider(opts.ah));
  const peopleClient = createClient(getWsProvider(opts.people));
  const ah = rpc(opts.ah);
  const people = rpc(opts.people);
  try {
    const ahApi = ahClient.getTypedApi(paseo_next_v2);
    const peopleApi = peopleClient.getTypedApi(paseo_people_next);
    const keys = {
      ahAccount: (addr) => ahApi.query.System.Account.getKey(addr),
      peopleCash: (addr) => peopleApi.query.Assets.Account.getKey(CASH_ON_PEOPLE, addr),
    };
    // Keys need the metadata once; resolve them through the typed api before the raw reads.
    const resolved = [];
    for (const run of runs) {
      const k = {
        ahAccount: await keys.ahAccount(run.job.burner),
        peopleCash: await keys.peopleCash(run.job.burner),
      };
      resolved.push(
        await enrich(
          run,
          ah,
          people,
          { ahAccount: () => k.ahAccount, peopleCash: () => k.peopleCash },
          heads,
          store.heads,
        ),
      );
    }
    process.stdout.write(
      (opts.json ? JSON.stringify(resolved, null, 2) : markdown(resolved)) + "\n",
    );
  } finally {
    ah.close();
    people.close();
    ahClient.destroy();
    peopleClient.destroy();
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(1);
});
