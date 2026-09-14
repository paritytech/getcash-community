import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { DEFAULT_THEME, THEMES } from "./app/theme/theme";

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
  },
});
