import type { Component } from "vue";

export interface FundingStatusDetail {
  key: string;
  label: string;
  value: string;
  /** Image URL for provider/token art, or a lucide component for generic glyphs
      (components inherit the row's colour; hardcoded-stroke SVGs do not). */
  icon?: string | Component;
  monospace?: boolean;
}
