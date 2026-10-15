// Renders the JSON of timeline-report.mjs as one HTML page: a summary, then one timeline per run.
// usage: node tools/timeline-page.mjs <report.json> [<title>] [<setup line>] > page.html
import fs from "node:fs";

const [file, title = "Top-up timelines", setup = ""] = process.argv.slice(2);
const runs = JSON.parse(fs.readFileSync(file, "utf8"));

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const clock = (t) => {
  if (t == null) return "–";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(Math.floor((t % 1000) / 100))}`;
};
const secs = (t0, t) => (t == null || t0 == null ? null : (t - t0) / 1000);
const fmt = (v) => (v == null ? "–" : v.toFixed(1));
const chainOf = (name) =>
  /Asset Hub|Swap/.test(name)
    ? "asset-hub"
    : /People|Top-up/.test(name)
      ? "people"
      : /Worker/.test(name)
        ? "worker"
        : "device";
const chainLabel = {
  "asset-hub": "Asset Hub",
  people: "People",
  worker: "Worker",
  device: "Device",
};
const deviceOf = (s) => s.deviceTime ?? s.hostHeadTime ?? null;
const anyTime = (s) => s.deviceTime ?? s.hostHeadTime ?? s.recorderTime ?? s.chainTime ?? null;

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const names = runs[0]?.steps.map((s) => s.name) ?? [];
const summaryRows = names.map((name, i) => {
  const v = runs.map((run) => secs(run.t0, anyTime(run.steps[i])));
  const present = v.filter((x) => x != null);
  return {
    name,
    median: median(v),
    min: present.length ? Math.min(...present) : null,
    max: present.length ? Math.max(...present) : null,
    n: present.length,
  };
});
const totals = runs.map((run) =>
  secs(run.t0, deviceOf(run.steps.find((s) => /purse/i.test(s.name)) ?? {})),
);

const runHtml = (run, i) => {
  const total = totals[i];
  return `
<section class="run" id="run-${i + 1}">
  <header class="run-head">
    <h2>Run ${i + 1}</h2>
    <p class="run-meta">Deposit seen ${esc(clock(run.t0))} · credit shown after <strong>${fmt(total)} s</strong> · burner <code>${esc(run.burner.slice(0, 8))}…${esc(run.burner.slice(-6))}</code></p>
  </header>
  <ol class="timeline">
  ${run.steps
    .map((s) => {
      const chain = chainOf(s.name);
      const device = deviceOf(s);
      const bits = [];
      if (s.block != null) bits.push(`block ${s.block}`);
      if (s.chainTime != null) bits.push(`block time ${clock(s.chainTime)}`);
      if (s.recorderTime != null) bits.push(`recorder ${clock(s.recorderTime)}`);
      if (s.note) bits.push(s.note);
      return `<li class="step ${chain}">
      <div class="when"><span class="t">${esc(clock(device))}</span><span class="plus">+${fmt(secs(run.t0, device))} s</span></div>
      <div class="dot"></div>
      <div class="what"><span class="badge">${chainLabel[chain]}</span><h3>${esc(s.name)}</h3>${bits.length ? `<p>${esc(bits.join(" · "))}</p>` : ""}</div>
    </li>`;
    })
    .join("\n")}
  </ol>
</section>`;
};

const html = `<title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: one column of run cards, each a vertical timeline with the time rail on the left. */
:root {
  --bg: #f6f5f2; --surface: #ffffff; --fg: #1d1c1a; --muted: #6b675f; --line: #dedbd4;
  --asset-hub: #b4530a; --people: #1f7a4d; --worker: #3f4fae; --device: #5c5853; --accent: #b4530a;
  --font-body: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #15151a; --surface: #1e1e24; --fg: #ebe8e1; --muted: #9b968c; --line: #33333b;
  --asset-hub: #f0a05a; --people: #5fcf92; --worker: #93a0f0; --device: #b5b0a6; --accent: #f0a05a; color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #15151a; --surface: #1e1e24; --fg: #ebe8e1; --muted: #9b968c; --line: #33333b;
  --asset-hub: #f0a05a; --people: #5fcf92; --worker: #93a0f0; --device: #b5b0a6; --accent: #f0a05a; color-scheme: dark;
}
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); font-size: 15px; line-height: 1.5; padding-inline: 16px; padding-block: 24px 48px; }
main { max-width: 880px; margin: 0 auto; display: grid; gap: 28px; }
h1 { font-size: 1.75rem; font-weight: 600; margin: 0 0 6px; text-wrap: balance; }
h2 { font-size: 1.15rem; font-weight: 600; margin: 0; }
h3 { font-size: 0.98rem; font-weight: 500; margin: 0; }
p { margin: 0; }
.lede { color: var(--muted); max-width: 65ch; }
.note { color: var(--muted); font-size: 0.9rem; max-width: 70ch; }
code { font-family: var(--font-mono); font-size: 0.9em; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; }
td.num, th.num { text-align: right; font-family: var(--font-mono); }
.table-wrap { overflow-x: auto; }
.run { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px 8px; }
.run-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; margin-bottom: 14px; }
.run-meta { color: var(--muted); font-size: 0.92rem; }
.timeline { list-style: none; margin: 0; padding: 0; }
.step { display: grid; grid-template-columns: 104px 18px minmax(0, 1fr); gap: 0 12px; position: relative; padding-bottom: 18px; }
.step:last-child { padding-bottom: 8px; }
.step::before { content: ""; position: absolute; left: 112px; top: 18px; bottom: -2px; width: 2px; background: var(--line); }
.step:last-child::before { display: none; }
.when { display: flex; flex-direction: column; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.when .t { font-size: 0.95rem; font-weight: 500; }
.when .plus { font-size: 0.82rem; color: var(--muted); }
.dot { width: 14px; height: 14px; margin-top: 4px; border-radius: 50%; border: 2px solid var(--device); background: var(--surface); position: relative; z-index: 1; justify-self: center; }
.step.asset-hub .dot { border-color: var(--asset-hub); }
.step.people .dot { border-color: var(--people); }
.step.worker .dot { border-color: var(--worker); }
.what { min-width: 0; display: grid; gap: 3px; }
.what p { color: var(--muted); font-size: 0.86rem; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.badge { display: inline-block; width: max-content; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; padding: 1px 7px; border-radius: 4px; border: 1px solid currentColor; color: var(--device); }
.step.asset-hub .badge { color: var(--asset-hub); }
.step.people .badge { color: var(--people); }
.step.worker .badge { color: var(--worker); }
@media (max-width: 520px) {
  .step { grid-template-columns: 78px 18px minmax(0, 1fr); gap: 0 8px; }
  .step::before { left: 86px; }
  .when .t { font-size: 0.85rem; }
}
@media (prefers-reduced-motion: no-preference) { .run { transition: border-color 0.2s; } }
</style>
<main>
  <header>
    <h1>${esc(title)}</h1>
    <p class="lede">${esc(setup)}</p>
  </header>
  <section>
    <h2>Median since the deposit was seen</h2>
    <p class="note">Seconds from the page seeing the deposit on Asset Hub's best block, on this Mac's clock. ${runs.length} runs.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Step</th><th class="num">Median s</th><th class="num">Min</th><th class="num">Max</th><th class="num">Runs</th></tr></thead>
      <tbody>${summaryRows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.median)}</td><td class="num">${fmt(r.min)}</td><td class="num">${fmt(r.max)}</td><td class="num">${r.n}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="note" style="margin-top:10px">Block time is each chain's own clock, which runs several seconds apart from this Mac's, so it only measures gaps between blocks of the same chain. Recorder is an independent watcher on this Mac that logs when each block became best and final.</p>
  </section>
  ${runs.map(runHtml).join("\n")}
</main>
`;
process.stdout.write(html);
