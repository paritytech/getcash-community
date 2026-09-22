// The seam the sell region/method picker reads its corridor catalog through.
//
// The adapter's `/supported*` routes now take an optional `direction`, "sell" included, serving
// Meld's real off-ramp catalog rather than the buy one standing in for it. This is wired straight
// to that: nothing above this file needs to change, since the picker only ever calls through the
// `MeldSellCorridorSource` shape.

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

export const sellCorridorSource: MeldSellCorridorSource = {
  loadCountries: () => fetchSupportedCountries("sell"),
  loadCorridors: () => fetchSupportedCorridors("sell"),
};
