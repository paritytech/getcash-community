// The build's telemetry literals (nuxt.config.ts `vite.define`). A null DSN is a build that
// opted out: the doorway's import of the core is then dead code and the bundle has no Sentry.
declare const __SENTRY_DSN__: string | null;
declare const __APP_VERSION__: string;
