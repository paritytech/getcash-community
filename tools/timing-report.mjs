#!/usr/bin/env node
// Turns iOS host logs of the GetCash app into a markdown timing report of top-up runs.
// Usage: node tools/timing-report.mjs <log file>... | --latest [--rpc[=wss url]] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_RPC = "wss://paseo-asset-hub-next-rpc.polkadot.io";
const TIMESTAMP_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
const LOG_GLOB =
  "Library/Developer/CoreSimulator/Devices/*/data/Containers/Data/Application/*/Library/Application Support/Logs/App/*.log";
const DAY = 86400000;
const NONE = "–";
const STAMPS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
const RUN_COLUMNS =
  "Mode|Route|Deposit seen|Deposit final|Conversion prepared|Conversion in block|Done|Claim registered|Host claimed|Purse credited|Host claimed final|Total";
const CLOCK_COLUMNS =
  "Route|Deposit block|Seen best|Seen final|Conversion block|Seen best|Seen final|People best at done";
const LEGS =
  "Total:t0:t7|Seen to final:t0:t1|Final to in block:t1:t3|In block to done:t3:t4|Done to claim registered:t4:t5|Registered to host claimed:t5:t6|Host claimed to credited:t6:t7";

const LINE = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) \S+ (\S+) - (.*)$/;
const KEY = /"key": SubstrateSdk\.JSON\.stringValue\("([^"]*)"\)/;
const VALUE = /"value": SubstrateSdk\.JSON\.stringValue\("0x([0-9a-fA-F]*)"\)/;
const TAG = /"tag": SubstrateSdk\.JSON\.stringValue\("(\w+)"\)/;
const FINAL = /"finalized": SubstrateSdk\.JSON\.boolValue\((true|false)\)/;
const HEAD = /^\(([^)]*?):wss?:\/\/[^)]*\) Did receive text: /;
const HEAD_KIND = /"method":"chain_(newHead|finalizedHead)"/;
const NUMBER = /"number":"0x([0-9a-fA-F]+)"/;
const CLAIM_START = /^Will start claim for group=(.+) amount=(\d+)/;
const CLAIM_DONE = /^Claiming completed: verdict=(\w+)\((.*)\) group=(.+)$/;
const REQUEST_KEY = /^getsome:request:([^:]+):(\d+)$/;

function parseArgs(argv) {
  const opts = { files: [], rpc: null, json: false };
  for (const arg of argv) {
    if (arg === "--latest") opts.files.push(latestLog());
    else if (arg === "--json") opts.json = true;
    else if (arg === "--rpc") opts.rpc = DEFAULT_RPC;
    else if (arg.startsWith("--rpc=")) opts.rpc = arg.slice(6);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else opts.files.push(arg);
  }
  if (opts.files.length === 0)
    throw new Error("usage: timing-report.mjs <log file>... | --latest [--rpc[=url]] [--json]");
  return opts;
}

const ls = (dir) =>
  fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? fs.readdirSync(dir) : [];

// Expands a path pattern whose star segments match a name suffix.
function expand(base, pattern) {
  let found = [base];
  for (const part of pattern.split("/")) {
    const next = [];
    for (const dir of found) {
      if (!part.startsWith("*")) next.push(path.join(dir, part));
      else for (const n of ls(dir)) if (n.endsWith(part.slice(1))) next.push(path.join(dir, n));
    }
    found = next;
  }
  return found;
}

function latestLog() {
  let best = null;
  for (const file of expand(os.homedir(), LOG_GLOB)) {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
  }
  if (!best) throw new Error("no simulator app log found");
  return best.file;
}

function fileDate(file) {
  const m = path.basename(file).match(/^(\d{4})_(\d\d)_(\d\d)_\d\d_\d\d_\d\d\.log$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const d = fs.statSync(file).mtime;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Reads one log file into the shared event store.
async function parseFile(file, store) {
  let day = fileDate(file);
  let prevMs = -1;
  const input = fs.createReadStream(file, "utf8");
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    const m = LINE.exec(line);
    if (!m) {
      if (line.trim()) store.unmatched.push(line.slice(0, 120));
      continue;
    }
    const ms = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    if (prevMs >= 0 && ms < prevMs - DAY / 2) day += DAY;
    prevMs = ms;
    const t = day + ms;
    const [source, msg] = [m[5], m[6]];
    if (source.startsWith("ContainerBridge.handleRequest") && msg.includes('"localStorageWrite"')) {
      parseWrite(t, msg, store);
    } else if (source.startsWith("ContainerBridge.handleSubscribe") && TAG.test(msg)) {
      const fin = FINAL.exec(msg);
      store.updates.push({ t, tag: TAG.exec(msg)[1], finalized: fin ? fin[1] === "true" : null });
    } else if (source.startsWith("ClaimAssetService.runClaim")) {
      const s = CLAIM_START.exec(msg);
      const d = CLAIM_DONE.exec(msg);
      if (s) store.claims.push({ t, group: s[1], start: true });
      else if (d) store.claims.push({ t, group: d[3], final: d[2].includes("finalized: true") });
      else store.unmatched.push(line.slice(0, 120));
    } else if (source.startsWith("WebSocketEngine+Delegate.handleTextEvent")) {
      const h = HEAD.exec(msg);
      const kind = h && HEAD_KIND.exec(msg);
      const n = kind && NUMBER.exec(msg);
      if (!h) store.unmatched.push(line.slice(0, 120));
      if (!n) continue;
      let chain = store.heads.get(h[1]);
      if (!chain) store.heads.set(h[1], (chain = { best: [], final: [] }));
      chain[kind[1] === "newHead" ? "best" : "final"].push([t, parseInt(n[1], 16)]);
    }
  }
}

function parseWrite(t, msg, store) {
  const k = KEY.exec(msg);
  const v = VALUE.exec(msg);
  if (!k || !v) return;
  const req = REQUEST_KEY.exec(k[1]);
  if (k[1] !== "getsome.funding.jobs" && !req) return;
  let value;
  try {
    value = JSON.parse(Buffer.from(v[1], "hex").toString("utf8"));
  } catch {}
  if (!value || typeof value !== "object")
    return store.unmatched.push(`${k[1]} at ${clock(t)} did not decode`);
  if (req) noteRequest(t, k[1], req[1], value, store);
  else for (const [sid, job] of Object.entries(value)) if (job) noteJob(t, sid, job, store);
}

function first(obj, key, t) {
  if (obj[key] == null) obj[key] = t;
}

function noteRequest(t, key, route, rec, store) {
  const burner = rec.handoff?.burnerAddress ?? rec.depositAddress ?? null;
  const id = `${key}@${burner ?? rec.startedAt ?? ""}`;
  let r = store.requests.get(id);
  if (!r) {
    r = { route, burner, label: rec.handoff?.label ?? null, start: t, seen: null, credited: null };
    store.requests.set(id, r);
  }
  const status = rec.status && typeof rec.status === "object" ? rec.status.kind : rec.status;
  if (status === "deposit-seen") first(r, "seen", t);
  if (rec.creditedAt != null) first(r, "credited", t);
}

// Records the first write that showed each fact of a job. Scratch data lives under x.
function noteJob(t, sid, job, store) {
  const id = `${sid}@${job.createdAt ?? ""}`;
  let run = store.runs.get(id);
  if (!run) {
    run = {
      mode: null,
      route: null,
      sessionId: sid,
      createdAt: job.createdAt ?? null,
      label: null,
      burnerAddress: null,
      stamps: Object.fromEntries(STAMPS.map((k) => [k, null])),
      depositBlock: null,
      conversionBlock: null,
      hostSaw: null,
      peopleBestAtDone: null,
      blockTimes: null,
      x: {
        start: t,
        hasDeposit: false,
        // A job whose first write already holds the deposit ran before this log began.
        restored: job.state?.fundsSeenAt != null || job.done === true,
        claimId: null,
        at: {},
        blocks: {},
      },
    };
    store.runs.set(id, run);
  }
  const { stamps, x } = run;
  if (job.mode != null) run.mode = String(job.mode);
  if (job.label) run.label = job.label;
  if (job.burnerAddress) run.burnerAddress = job.burnerAddress;
  if (job.state?.fundsSeenAt != null) {
    x.hasDeposit = true;
    first(stamps, "t1", t);
  }
  if (job.depositSeen) {
    x.hasDeposit = true;
    if (job.depositSeen.block != null) run.depositBlock = job.depositSeen.block;
  }
  if (job.conversion?.preparedAt != null) first(x.at, "prepared", t);
  if (job.submitting) first(x.at, "submitting", t);
  if (job.conversion?.converted) {
    first(x.at, "converted", t);
    if (job.conversion.converted.block != null) x.blocks.converted = job.conversion.converted.block;
  }
  if (Array.isArray(job.txs) && job.txs.length) {
    first(x.at, "firstTx", t);
    const last = job.txs[job.txs.length - 1];
    if (last?.block != null) x.blocks.tx = last.block;
  }
  if (job.state?.inclusionBlock != null) x.blocks.inclusion = job.state.inclusionBlock;
  if (job.done === true) first(stamps, "t4", t);
  if (job.claim?.registeredAt != null) first(stamps, "t5", t);
  if (job.claim?.id) x.claimId = job.claim.id;
}

// Picks the chain whose name ends with the suffix and has the most best heads.
function pickChain(heads, suffix) {
  const named = [...heads].filter(([name]) => name.endsWith(suffix)).map(([, chain]) => chain);
  return named.sort((a, b) => b.best.length - a.best.length)[0] ?? { best: [], final: [] };
}

const seenAtOrPast = (list, block) =>
  block == null ? null : (list.find(([, n]) => n >= block)?.[0] ?? null);
const lastBefore = (list, t) => (t == null ? null : (list.findLast((e) => e[0] <= t)?.[1] ?? null));

function buildRuns(store) {
  const runs = [...store.runs.values()].filter((r) => r.x.hasDeposit && !r.x.restored);
  runs.sort((a, b) => a.x.start - b.x.start);
  const requests = [...store.requests.values()].sort((a, b) => a.start - b.start);
  const used = new Set();
  for (const run of runs) {
    const free = requests.filter((q) => !used.has(q));
    const req =
      free.find((q) => q.burner && q.burner === run.burnerAddress) ??
      free.find((q) => q.label && q.label === run.label) ??
      free[0];
    if (req) used.add(req);
    const { stamps, x } = run;
    run.route = req?.route ?? "?";
    stamps.t0 = req?.seen ?? null;
    stamps.t7 = req?.credited ?? null;
    stamps.t2 = x.at.prepared ?? x.at.submitting ?? null;
    stamps.t3 = x.at.converted ?? x.at.firstTx ?? null;
    run.conversionBlock = x.blocks.converted ?? x.blocks.tx ?? x.blocks.inclusion ?? null;
    const hex = x.claimId ? x.claimId.replace(/^0x/, "") : null;
    x.claims = hex ? store.claims.filter((c) => c.group.endsWith(hex)) : [];
    stamps.t5 ??= x.claims.find((c) => c.start)?.t ?? null;
  }
  const claimed = runs.filter((r) => r.stamps.t5 != null).sort((a, b) => a.stamps.t5 - b.stamps.t5);
  claimed.forEach((run, i) => {
    const t5 = run.stamps.t5;
    const end = claimed[i + 1]?.stamps.t5 ?? Infinity;
    const mine = store.updates.filter((u) => u.tag === "Claimed" && u.t >= t5 && u.t < end);
    run.stamps.t6 = mine.find((u) => u.finalized === false)?.t ?? null;
    run.stamps.t8 =
      mine.find((u) => u.finalized === true)?.t ?? run.x.claims.find((c) => c.final)?.t ?? null;
  });
  const ah = pickChain(store.heads, "Asset Hub");
  const people = pickChain(store.heads, "People");
  for (const run of runs) {
    run.hostSaw = {
      depositBest: seenAtOrPast(ah.best, run.depositBlock),
      depositFinal: seenAtOrPast(ah.final, run.depositBlock),
      conversionBest: seenAtOrPast(ah.best, run.conversionBlock),
      conversionFinal: seenAtOrPast(ah.final, run.conversionBlock),
    };
    run.peopleBestAtDone = lastBefore(people.best, run.stamps.t4);
  }
  return runs;
}

function leU64(hex) {
  const bytes = hex.replace(/^0x/, "").match(/../g) ?? [];
  return Number(BigInt("0x" + (bytes.reverse().join("") || "0")));
}

async function fetchBlockTimes(url, blocks) {
  const times = new Map();
  const pending = new Map();
  let nextId = 1;
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  };
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      setTimeout(() => pending.delete(id) && reject(new Error("timeout")), 15000).unref();
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("connection failed"));
      setTimeout(() => reject(new Error("connect timeout")), 15000).unref();
    });
    for (const n of blocks) {
      try {
        const hash = await call("chain_getBlockHash", [n]);
        const raw = hash ? await call("state_getStorage", [TIMESTAMP_KEY, hash]) : null;
        if (raw) times.set(n, leU64(raw));
      } catch (e) {
        process.stderr.write(`block ${n}: ${e.message}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`rpc ${url}: ${e.message}\n`);
  }
  ws.close();
  return times;
}

const clock = (t) => new Date(t).toTimeString().slice(0, 8);
const secs = (ms) => (ms == null ? NONE : (ms / 1000).toFixed(1));
const delta = (a, b) => (a == null || b == null ? null : b - a);
const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (headers, rows) =>
  [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");

function stats(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return NONE;
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return `${secs(median)} (${secs(v[0])}–${secs(v[v.length - 1])})`;
}

function markdown(runs, withRpc) {
  const since = (r, t) => secs(delta(r.stamps.t0, t));
  const runRows = runs.map((r) => [
    r.mode ?? "?",
    r.route,
    r.stamps.t0 == null ? NONE : clock(r.stamps.t0),
    ...STAMPS.slice(1).map((k) => since(r, r.stamps[k])),
    since(r, r.stamps.t7),
  ]);
  const modes = [...new Set(runs.map((r) => r.mode ?? "?"))];
  const modeRows = modes.map((mode) => {
    const mine = runs.filter((r) => (r.mode ?? "?") === mode);
    const legs = LEGS.split("|").map((leg) => leg.split(":"));
    return [
      mode,
      mine.length,
      ...legs.map(([, a, b]) => stats(mine.map((r) => delta(r.stamps[a], r.stamps[b])))),
    ];
  });
  const clockRows = runs.map((r) => [
    r.route,
    r.depositBlock ?? NONE,
    since(r, r.hostSaw.depositBest),
    since(r, r.hostSaw.depositFinal),
    r.conversionBlock ?? NONE,
    since(r, r.hostSaw.conversionBest),
    since(r, r.hostSaw.conversionFinal),
    r.peopleBestAtDone ?? NONE,
    ...(withRpc ? [since(r, r.blockTimes?.deposit), since(r, r.blockTimes?.conversion)] : []),
  ]);
  const clockColumns = CLOCK_COLUMNS.split("|");
  if (withRpc) clockColumns.push("Deposit block time", "Conversion block time");
  return [
    "## Runs\n",
    table(RUN_COLUMNS.split("|"), runRows),
    "\n## Per mode\n",
    table(["Mode", "Runs", ...LEGS.split("|").map((leg) => leg.split(":")[0])], modeRows),
    "\n## Chain clock\n",
    table(clockColumns, clockRows),
  ].join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const store = { runs: new Map(), requests: new Map(), heads: new Map() };
  Object.assign(store, { updates: [], claims: [], unmatched: [] });
  for (const file of opts.files) await parseFile(file, store);
  for (const chain of store.heads.values())
    for (const list of Object.values(chain)) list.sort((a, b) => a[0] - b[0]);
  store.updates.sort((a, b) => a.t - b.t);
  store.claims.sort((a, b) => a.t - b.t);
  const runs = buildRuns(store);
  if (opts.rpc) {
    const blocks = runs
      .flatMap((r) => [r.depositBlock, r.conversionBlock])
      .filter((b) => b != null);
    const times = await fetchBlockTimes(
      opts.rpc,
      [...new Set(blocks)].sort((a, b) => a - b),
    );
    for (const r of runs) {
      const [deposit, conversion] = [r.depositBlock, r.conversionBlock].map(
        (b) => times.get(b) ?? null,
      );
      r.blockTimes = { deposit, conversion };
    }
  }
  const plain = runs.map(({ x, ...r }) => r);
  process.stdout.write(
    (opts.json ? JSON.stringify(plain, null, 2) : markdown(runs, !!opts.rpc)) + "\n",
  );
  const odd = store.unmatched;
  if (odd.length)
    process.stderr.write(`${odd.length} line(s) outside the known shapes, first: ${odd[0]}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
