/**
 * WHAT PEOPLE DO: one `ui.action` counter per user action (ACTIONS in
 * catalogue.ts), by `action` and the screen it was done on, and a devLog line,
 * so a failure's breadcrumbs say what the person had just done.
 *
 * Counts and fixed words only: an action's attributes say how (`via: 'menu'`,
 * `on: 'true'`), never what was typed, chosen or who it was for. Never throws.
 */
import { devLog } from "../log";
import type { ActionName } from "./catalogue";
import { recordCount } from "./metrics";
import { currentScreen } from "./screens";

export type { ActionName };

export function trackAction(action: ActionName, attrs: Record<string, string> = {}): void {
  try {
    const screen = currentScreen();
    devLog("action", action, Object.keys(attrs).length > 0 ? attrs : undefined);
    recordCount("ui.action", 1, { action, screen, ...attrs });
  } catch {
    /* never throws */
  }
}
