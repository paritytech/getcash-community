/**
 * Every scope tag key the shared core sets (init.ts). A leaf, so metrics.ts
 * can copy them onto a point without importing init. The masking test reads
 * it too.
 */
export const TAG_KEYS = [
  "product",
  "host.kind",
  "session.id",
  "env.source",
  "device.os",
  "device.os_version",
  "device.model",
  "device.cores",
  "device.memory",
  "device.engine",
  "device.engine_version",
  "host.app",
  "host.app_version",
  "net.type",
  "net.effective",
] as const;
