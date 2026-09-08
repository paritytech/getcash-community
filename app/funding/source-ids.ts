// Maps a request's source id to its rail. Records with no source id belong to the crypto rail.

/** The crypto rail's session source: a direct dot-assethub deposit (Chainflip or manual). */
export const CRYPTO_SOURCE_ID = "dot-assethub";

/** The Meld fiat rail's sources, one per payment method. */
export const MELD_SOURCE_IDS = ["meld-card", "meld-bank"] as const;
export type MeldSourceId = (typeof MELD_SOURCE_IDS)[number];

export const isMeldSourceId = (sourceId: string | undefined): sourceId is MeldSourceId =>
  sourceId !== undefined && (MELD_SOURCE_IDS as readonly string[]).includes(sourceId);

/** The Meld payment methods the shell offers as routes, and the source each runs under. */
export type MeldMethod = "card" | "bank";
export const meldSourceIdFor = (method: MeldMethod): MeldSourceId =>
  method === "card" ? "meld-card" : "meld-bank";
export const meldMethodFor = (sourceId: MeldSourceId): MeldMethod =>
  sourceId === "meld-card" ? "card" : "bank";

/** A source the crypto rail serves: its own, or none. */
export const isCryptoSourceId = (sourceId: string | undefined): boolean =>
  sourceId === undefined || sourceId === CRYPTO_SOURCE_ID;
