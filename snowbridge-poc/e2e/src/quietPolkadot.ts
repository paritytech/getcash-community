// polkadot-js warns when two copies of one version load; the assethub tools and the services each bring their own.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("@polkadot/") && first.includes("has multiple versions")) return;
  warn(...args);
};
