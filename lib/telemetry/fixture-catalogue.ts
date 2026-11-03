/**
 * TEST FIXTURE: a catalogue for the shared core's tests, which load it in
 * place of the app's (`vi.mock('./catalogue', () => import('./fixture-catalogue'))`),
 * so they hold for any app's.
 */
export const JOURNEYS = {
  trial: { steps: ["first", "second"], outcomes: ["done"] },
  slow: { steps: ["wait", "prompt"], outcomes: ["done"], stuckMs: 1_000, waitSteps: ["prompt"] },
} as const;

export const FAILURE_KINDS = ["broke", "said-no", "stuck", "unclean-exit"] as const;

export const isExpected = (kind: string): boolean => kind === "said-no";

export const APP_TAGS = [] as const;

export const SCREENS = ["first-screen", "second-screen"] as const;

export const ACTIONS = ["tap"] as const;
