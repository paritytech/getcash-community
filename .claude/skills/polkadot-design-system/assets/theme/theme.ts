/**
 * Theme switching for the Polkadot design system.
 *
 * "system" is the absence of a data-theme attribute: themes.css puts Berlin Day
 * on bare :root and Berlin Night behind prefers-color-scheme, so removing the
 * attribute hands control back to the OS.
 */

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

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The stored choice, or "system" when nothing valid is stored. */
export function getTheme(): ThemeChoice {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : "system";
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
    localStorage.removeItem(STORAGE_KEY);
  } else {
    root.setAttribute("data-theme", choice);
    localStorage.setItem(STORAGE_KEY, choice);
  }
}

/** Call once on mount to reapply the stored choice. */
export function initTheme(): void {
  const choice = getTheme();
  if (choice !== "system") document.documentElement.setAttribute("data-theme", choice);
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
