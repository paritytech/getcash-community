import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { DECIMALS, readTopUpBounds } from "./app/funding/bounds";
import { formatFundingAmount } from "./app/funding/selection";
import { DEFAULT_THEME, THEMES } from "./app/theme/theme";
import papiConfig from "./.papi/polkadot-api.json";
import { NETWORK } from "./packages/core/src/network";

// The faucet seed is inlined into the bundle, so a network with real funds must never get one.
if (!NETWORK.testnet && process.env.VITE_FAUCET_SEED?.trim()) {
  throw new Error(
    "VITE_FAUCET_SEED is set, but packages/core/src/network.json does not mark the network as a testnet",
  );
}

// The top-up bounds are inlined too. A value the app ignores is reported here, in the build log
// whoever set it reads, with the bounds the build uses instead.
const topUpBounds = readTopUpBounds({
  minimum: process.env.VITE_TOP_UP_MINIMUM,
  maximum: process.env.VITE_TOP_UP_MAXIMUM,
});
const topUpRange = `${formatFundingAmount(topUpBounds.minimum, DECIMALS)} to ${formatFundingAmount(topUpBounds.maximum, DECIMALS)} CASH`;
for (const problem of topUpBounds.problems) {
  console.warn(`[config] ${problem}; ignored`);
}
console.info(`[config] top-up bounds: ${topUpRange}`);

// The app dials the chains network.json names, with calls typed from the metadata in .papi/.
for (const [chain, papiGenesis] of [
  ["assetHub", papiConfig.entries.paseo_next_v2.genesis],
  ["people", papiConfig.entries.paseo_people_next.genesis],
] as const) {
  if (NETWORK[chain].genesis !== papiGenesis) {
    throw new Error(
      `packages/core/src/network.json and .papi/polkadot-api.json name different ${chain} genesis hashes`,
    );
  }
}

// The build's name in Sentry: the release is `getcash@<this>` (lib/telemetry/config.ts). A hash
// of the tracked sources, not the commit, so a commit touching only docs or CI builds the same
// bytes and bulletin-deploy keeps its CID. `git ls-files -s` lists blob hashes, so CI's shallow
// checkout works too. Outside a git checkout it is `dev`.
function buildVersion(): string {
  try {
    const files = execSync(
      "git ls-files -s -- . ':(exclude)*.md' ':(exclude).github' ':(exclude).claude'",
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] },
    );
    return createHash("sha256").update(files).digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
}

// Telemetry is a build's opt-in. The DSN is a literal in the bundle, so without one the telemetry
// doorway's import of the Sentry core is dead code and the build has no Sentry at all.
const sentryDsn = process.env.VITE_SENTRY_DSN?.trim() || null;
const telemetryDefines = {
  __SENTRY_DSN__: JSON.stringify(sentryDsn),
  __APP_VERSION__: JSON.stringify(buildVersion()),
};
console.info(`[config] telemetry: ${sentryDsn ? "on" : "off, no Sentry in the bundle"}`);

export default defineNuxtConfig({
  // Static SPA; there is no server.
  ssr: false,
  compatibilityDate: "2026-08-01",
  app: {
    head: {
      title: "getcash",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      ],
      script: [
        {
          // Theme anti-flash: set data-theme before the first paint so a stored
          // choice never flashes the default theme. Must precede every stylesheet;
          // initTheme() is the fallback for documents we can't edit — never both.
          // Berlin Night is the product default (Funding — states and logic doc);
          // "system" is an explicit opt-in, not the fallback. A stored value that
          // matches no theme block (stale key, another app's value) must fall back
          // too, or the page silently renders the bare :root theme.
          innerHTML:
            `try{var v=${JSON.stringify(THEMES)},t=localStorage.getItem('pds-theme');` +
            `if(t!=='system')document.documentElement.setAttribute('data-theme',v.indexOf(t)>=0?t:'${DEFAULT_THEME}')}` +
            `catch(e){document.documentElement.setAttribute('data-theme','${DEFAULT_THEME}')}`,
          tagPriority: "critical",
        },
      ],
    },
  },
  modules: ["@pinia/nuxt"],
  // Component names come from the FILE name alone; subdirectories organize, they do
  // not namespace (<AmountScreen>, not <ScreensAmountScreen>). Only .vue files are
  // components: shadcn's index.ts barrels (components/ui/*/index.ts) are import
  // surfaces, not components, and would otherwise collide with their .vue siblings.
  components: [{ path: "~/components", pathPrefix: false, extensions: ["vue"] }],
  css: ["~/assets/css/main.css"],
  // Hash routing survives static hosting and host webviews without server rewrites.
  router: { options: { hashMode: true } },
  typescript: {
    tsConfig: {
      compilerOptions: {
        // lib/ was authored under the old app's compiler settings, which did not have
        // this flag; the engine packages keep it on via their own tsconfig.
        noUncheckedIndexedAccess: false,
      },
    },
  },
  vite: {
    plugins: [
      tailwindcss(),
      // polkadot-api and @chainflip/sdk expect node globals in the browser bundle
      nodePolyfills({
        include: ["buffer", "crypto", "stream", "util", "events", "process"],
        globals: { Buffer: true, global: true, process: true },
      }),
    ],
    build: { target: "es2022" },
    define: telemetryDefines,
  },
});
