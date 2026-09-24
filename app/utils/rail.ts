// Whether this build lets a pick reach a Chainflip route. Demo builds keep the routes open so
// the flows can be walked end to end, with the dev skip standing in for the swap; a real build
// greys them until the channel rail is switched on.

import { CHAINFLIP_RAIL_ENABLED } from "~~/lib/config";
import { isDemoBuild } from "./demo";

export const chainflipRailOn = (): boolean => CHAINFLIP_RAIL_ENABLED || isDemoBuild();
