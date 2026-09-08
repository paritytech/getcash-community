import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

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
          // "system" is an explicit opt-in, not the fallback.
          innerHTML:
            "try{var t=localStorage.getItem('pds-theme');if(t!=='system')document.documentElement.setAttribute('data-theme',t||'berlin-night')}catch(e){document.documentElement.setAttribute('data-theme','berlin-night')}",
          tagPriority: "critical",
        },
      ],
    },
  },
  modules: ["@pinia/nuxt"],
  // Component names come from the file name alone; subdirectories do not namespace.
  components: [{ path: "~/components", pathPrefix: false }],
  css: ["~/assets/css/main.css"],
  // Hash routing survives static hosting and host webviews without server rewrites.
  router: { options: { hashMode: true } },
  typescript: {
    tsConfig: {
      compilerOptions: {
        // lib/ does not compile with this flag; the packages keep it on in their own tsconfig.
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
