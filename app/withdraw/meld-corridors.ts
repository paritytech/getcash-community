// The seam the sell region/method picker reads its corridor catalog through.
//
// The adapter's sell corridor endpoint does not exist yet: DOT_ASSETHUB is not sellable on the
// sandbox account and the adapter's sell routes are only partly built (see the brief this step was
// built from). Until it ships, this seam is wired to the BUY catalog's `/supported` endpoints
// (`~~/lib/supported`), which at least answers the same shape — country in, methods and limits out
// — for the same asset. That is a stand-in, not a real answer: a corridor the buy side lists as
// deliverable is not proof Meld will take it on a sell, and the reverse. Swap `sellCorridorSource`
// for the adapter's real sell endpoints once they land; nothing above this file needs to change,
// since the picker only ever calls through the `MeldSellCorridorSource` shape.

import {
  fetchSupportedCorridors,
  fetchSupportedCountries,
  type SupportedCorridor,
  type SupportedCountry,
} from "~~/lib/supported";

export interface MeldSellCorridorSource {
  loadCountries(): Promise<SupportedCountry[] | null>;
  loadCorridors(): Promise<Map<string, SupportedCorridor> | null>;
}

/** STAND-IN: the buy corridor catalog, not a sell one — see this file's header. */
export const sellCorridorSource: MeldSellCorridorSource = {
  loadCountries: fetchSupportedCountries,
  loadCorridors: fetchSupportedCorridors,
};
