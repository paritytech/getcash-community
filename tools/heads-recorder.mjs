// Records when each chain's best and finalized heads move, on this machine's clock, as JSON
// lines: {"t": ms, "chain": name, "kind": "best" | "final", "number": n}. Reconnects when a
// connection drops. usage: node tools/heads-recorder.mjs <out file> <name>=<wss url>...
import fs from "node:fs";

const [out, ...chains] = process.argv.slice(2);
if (!out || chains.length === 0) {
  console.error("usage: heads-recorder.mjs <out file> <name>=<wss url>...");
  process.exit(1);
}
const file = fs.createWriteStream(out, { flags: "a" });
const record = (line) => file.write(`${JSON.stringify(line)}\n`);

function follow(name, url) {
  const ws = new WebSocket(url);
  let id = 0;
  ws.onopen = () => {
    for (const method of ["chain_subscribeNewHeads", "chain_subscribeFinalizedHeads"]) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: [] }));
    }
    record({ t: Date.now(), chain: name, kind: "open" });
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const kind =
      msg.method === "chain_newHead"
        ? "best"
        : msg.method === "chain_finalizedHead"
          ? "final"
          : null;
    if (!kind) return;
    record({ t: Date.now(), chain: name, kind, number: parseInt(msg.params.result.number, 16) });
  };
  ws.onclose = () => {
    record({ t: Date.now(), chain: name, kind: "closed" });
    setTimeout(() => follow(name, url), 3000);
  };
  ws.onerror = () => ws.close();
}

for (const arg of chains) {
  const [name, url] = arg.split("=");
  follow(name, url);
}
