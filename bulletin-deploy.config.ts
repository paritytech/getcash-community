// Product manifest. `bulletin-deploy` writes the root manifest as the `manifest` record on the
// base name and one `executable` record per entry on its own subname (`app.<domain>`,
// `worker.<domain>`). DEPLOY_DOMAIN selects the target name; unset means production.
export default {
  domain: process.env.DEPLOY_DOMAIN || "getcash.paseo",
  displayName: "getcash",
  description: "Buy CASH into your private Polkadot App funds.",
  icon: { path: "brand/icon.png", format: "png" },
  // Hosts open the surface through `app`; the Add-funds hand-off arrives as its query parameters.
  executables: [
    {
      kind: "app",
      path: ".output/public",
      appVersion: [0, 1, 0],
    },
    {
      kind: "worker",
      // The built bundle as the site build copies it into .output/public/worker.
      path: ".output/public/worker",
      appVersion: [0, 1, 0],
      // Relative to this executable's own archive, where the bundle sits at the root.
      entrypoint: "index.js",
      // Background logic with no chat surface. Hosts currently start a worker only when it
      // declares chat.
      includes: { chat: true, pocket: false },
    },
  ],
};
