// What a picker list draws per row, and the one order every picker lists them in: the rows
// that can be picked first, then the ones that cannot, each keeping its catalog position.
// Pure, so the top-up and withdrawal pickers read alike without sharing a store.

export interface OptionListRow {
  /** Stable identity for the row, the chain or asset it stands for. */
  key: string;
  icon: string;
  label: string;
  /** Why the row cannot be picked; nothing when it can. */
  subtitle?: string;
  pickable: boolean;
  /** This row's pick is in flight: the chevron gives way to a spinner. */
  busy?: boolean;
}

/** Pickable rows first, then the rest, each group in its given order. */
export const sortPickable = <T extends { pickable: boolean }>(rows: readonly T[]): T[] => [
  ...rows.filter((row) => row.pickable),
  ...rows.filter((row) => !row.pickable),
];
