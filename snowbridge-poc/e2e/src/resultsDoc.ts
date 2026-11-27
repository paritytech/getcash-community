import { renderMarkdown, type Scenario } from "./report";
import type { E2eDeployment } from "./deployment";

export type ResultsInput = {
  runId: string;
  startedAt: Date;
  dep: E2eDeployment;
  scenarios: Scenario[];
  relayerLines: string[];
  finalState: string[];
};

const REPRODUCE = `\`\`\`
snowbridge-poc/setup.sh                # sources, builds, stack, TEST token, deploy, relayer swap, then S1-S6 (writes this file)
snowbridge-poc/setup.sh --scenarios    # S1-S6 again on the running stack
\`\`\`

Step by step, from \`snowbridge-poc\` with the environment \`setup.sh\` exports (\`OUTPUT_DIR\`, \`SNOWBRIDGE_DIR\`):

\`\`\`
pnpm --dir e2e install
pnpm --dir e2e exec tsx src/registerToken.ts   # only after a stack restart: registers TEST on the Gateway, waits for Asset Hub
pnpm --dir e2e run deploy                      # keys, pool, registry, factory, router, payer funds (needs the stock relayer for the TEST bridge)
pnpm --dir e2e run e2e                         # baseline scenarios B1-B5 against whichever relayer runs
pnpm --dir e2e run relayer swap                # patched relayer in, stack's loop restarts ethereum-v3
pnpm --dir e2e run scenarios                   # S1-S6, writes this file
\`\`\``;

const REVERT = `\`\`\`
snowbridge-poc/setup.sh --revert-relayer
\`\`\`

This restores \`$OUTPUT_DIR/ethereum-v3.json\` and \`$OUTPUT_DIR/bin/snowbridge-relay\` (\`OUTPUT_DIR\` defaults to \`/tmp/snowbridge-v2\`) from the \`.stock\` copies the swap made, by rename, and kills only the ethereum-v3 process; the stack's loop starts it again with the stock config. Done by hand:

\`\`\`
cp $OUTPUT_DIR/ethereum-v3.json.stock $OUTPUT_DIR/ethereum-v3.json
cp $OUTPUT_DIR/bin/snowbridge-relay.stock $OUTPUT_DIR/bin/snowbridge-relay.new && mv -f $OUTPUT_DIR/bin/snowbridge-relay.new $OUTPUT_DIR/bin/snowbridge-relay
pkill -f "snowbridge-relay run ethereum-v3"
\`\`\`

After a revert the stock relayer delivers every message its fee rule accepts, including the stranger messages of S4, which stay pending until then (they carry relayer fee 0 and the stock config's minimum fee is 0).`;

const NOTES = `- The stack the scenarios ran on was rebuilt from the fork, so the stack's own \`snowbridge-relay\` is byte-identical to the patched binary. The getcash filter is dormant without a \`getcash\` block in the config, so the swap is a config change plus a restart of ethereum-v3; the stock behaviour is the config without that block.
- \`deploy.ts\` passes the admin key to \`forge script\` with \`--private-key\`, which shows in \`ps\`. Acceptable for a local dev key; a production deployment must use a hardware wallet or keystore.
- The trigger and payout services run from source under this harness, each with only its own variables. The trigger key reaches only the trigger service, through an env file it re-reads on SIGHUP; the payout service gets \`START_BLOCK\` at the Ethereum head and fronts only deposits whose trigger transaction was signed by the registry's relayer at that transaction (S4 asserts it).
- A mined Gateway log, the relayer log and Bridge Hub's nonce bitmap are the three sources of evidence for delivery. The relayer confirms each message with "successfully processed" only on its batch path; on its catch-up path (a beacon update sent together with the message) it logs only "catch-up: Including EthereumInboundQueueV2.submit", so the harness requires the latter.
- S4 messages stay pending on purpose: a public relayer would deliver them. They are the reason the stock relayer must not be reinstated casually.`;

export function renderResults(input: ResultsInput): string {
  const { runId, startedAt, dep, scenarios, relayerLines, finalState } = input;
  const ok = scenarios.every((scenario) => scenario.ok);
  return [
    "# M3 results: the patched relayer on the local stack",
    "",
    `Run \`${runId}\`, ${startedAt.toISOString()}. Overall: **${ok ? "all scenarios pass" : "failures, see below"}**.`,
    "",
    `Deployment: Registry \`${dep.registry}\` (deploy block ${dep.registryDeployBlock}), Router \`${dep.router}\`, Factory \`${dep.factory}\`, Pool \`${dep.pool}\`, Gateway \`${dep.gateway}\`.`,
    "",
    "Our patched relayer was the only Ethereum to Polkadot relayer, and every Gateway message of the run had relayer fee 0.",
    "",
    "## How to reproduce",
    "",
    REPRODUCE,
    "",
    "## Relayer swap",
    "",
    ...relayerLines.map((line) => `- ${line}`),
    "",
    "## Scenarios",
    "",
    renderMarkdown(scenarios),
    "## State left",
    "",
    ...finalState.map((line) => `- ${line}`),
    "",
    "## Reverting to the stock relayer",
    "",
    REVERT,
    "",
    "## Notes",
    "",
    NOTES,
    "",
  ].join("\n");
}
