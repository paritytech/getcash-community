/**
 * Theme switching for the Polkadot design system.
 *
 * Berlin Night is the product default (see "Funding — states and logic"):
 * nothing stored means data-theme="berlin-night". "system" is an explicit
 * opt-in stored as its own value; it removes the attribute so themes.css
 * hands control to the OS (bare :root is Berlin Day, prefers-color-scheme
 * swaps in Berlin Night).
 */

import type { ThemeMode } from "@parity/product-sdk-host";

export const THEMES = ["berlin-day", "berlin-night", "lisbon", "malta", "tokyo"] as const;

export type Theme = (typeof THEMES)[number];
export type ThemeChoice = Theme | "system";

/** Themes with a dark surface. Lisbon, Malta and Tokyo are light-only. */
export const DARK_THEMES: readonly Theme[] = ["berlin-night"];

export const THEME_LABELS: Record<Theme, string> = {
  "berlin-day": "Berlin Day",
  "berlin-night": "Berlin Night",
  lisbon: "Lisbon",
  malta: "Malta",
  tokyo: "Tokyo",
};

const STORAGE_KEY = "pds-theme";

export const DEFAULT_THEME: Theme = "berlin-night";

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/* Storage is best-effort. A cross-origin iframe with storage partitioned off
   (Safari's tracking prevention, sandboxed frames) throws SecurityError on
   property ACCESS, so a `typeof localStorage` check does not catch it. */
function readStoredChoice(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // No storage: the choice still applies for this session, it just won't
    // survive a reload (the anti-flash script falls back to the default).
  }
}

/** The stored choice, or the default when nothing valid is stored. */
export function getTheme(): ThemeChoice {
  const stored = readStoredChoice();
  if (stored === "system") return "system";
  return isTheme(stored) ? stored : DEFAULT_THEME;
}

/** The theme actually rendering right now, resolving "system". */
export function resolveTheme(choice: ThemeChoice = getTheme()): Theme {
  if (choice !== "system") return choice;
  const prefersDark =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "berlin-night" : "berlin-day";
}

export function setTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
  writeStoredChoice(choice);
}

/**
 * Map the host's theme onto one of ours. A recognised custom name wins
 * ("Berlin Night" → berlin-night); otherwise the light/dark variant decides,
 * since the host may ship themes we don't have blocks for.
 */
export function themeFromHost(mode: ThemeMode): Theme {
  if (mode.name.tag === "Custom") {
    const named = mode.name.value.trim().toLowerCase().replace(/\s+/g, "-");
    if (isTheme(named)) return named;
  }
  return mode.variant === "Dark" ? "berlin-night" : "berlin-day";
}

/** Call once on mount to reapply the stored choice. */
export function initTheme(): void {
  const choice = getTheme();
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", choice);
  }
}

/** Subscribe to OS changes while the choice is "system". Returns an unsubscribe. */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getTheme() === "system") onChange(resolveTheme("system"));
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
