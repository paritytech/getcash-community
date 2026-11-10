// The top-up's timeline as the designer drew it: seven milestones on a 370 px card, Started,
// Received and Added named.

import { MILESTONES, type Milestone, type TimelineSpec } from "./types";

export const TOP_UP_TIMELINE: TimelineSpec<Milestone> = {
  ariaLabel: "Top-up progress",
  failedLabel: "Failed",
  designWidth: 370,
  milestones: [
    { id: "started", label: "Started", centre: 34.5 },
    { id: "accepted", centre: 77 },
    { id: "sent", centre: 141 },
    { id: "received", label: "Received", centre: 187.5 },
    { id: "converted", centre: 234 },
    { id: "moved", centre: 298 },
    { id: "added", label: "Added", centre: 338 },
  ],
};

if (TOP_UP_TIMELINE.milestones.some(({ id }, index) => id !== MILESTONES[index])) {
  throw new Error("The top-up spec must list MILESTONES in order");
}
