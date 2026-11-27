export type Check = { name: string; ok: boolean; detail: string };

// One scenario's checks, key timings (seconds) and references (transaction hashes, blocks, nonces).
export class Scenario {
  readonly checks: Check[] = [];
  readonly seconds: Record<string, number> = {};
  readonly refs: Record<string, string | number> = {};

  constructor(
    readonly id: string,
    readonly title: string,
  ) {}

  check(name: string, ok: boolean, detail = ""): boolean {
    this.checks.push({ name, ok, detail });
    console.log(`  ${ok ? "ok  " : "FAIL"} [${this.id}] ${name}${detail ? ` (${detail})` : ""}`);
    return ok;
  }

  time(key: string, ms: number | undefined): void {
    if (ms !== undefined) this.seconds[key] = Math.round(ms / 100) / 10;
  }

  ref(key: string, value: string | number | bigint | undefined): void {
    if (value !== undefined) this.refs[key] = typeof value === "bigint" ? value.toString() : value;
  }

  abort(error: unknown): void {
    this.check("the scenario ran to its end", false, error instanceof Error ? error.message : String(error));
  }

  get ok(): boolean {
    return this.checks.length > 0 && this.checks.every((entry) => entry.ok);
  }
}

// A scenario that throws fails on its own; the others carry on.
export async function guard(scenario: Scenario, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (error) {
    scenario.abort(error);
  }
}

export const jsonReplacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

const verdict = (scenario: Scenario) => (scenario.ok ? "pass" : "FAIL");
const passed = (scenario: Scenario) => `${scenario.checks.filter((entry) => entry.ok).length}/${scenario.checks.length}`;

export function renderSummary(scenarios: Scenario[]): string {
  const width = Math.max(8, ...scenarios.map((scenario) => scenario.title.length));
  const rows = scenarios.map((scenario) => `${scenario.id.padEnd(4)} ${scenario.title.padEnd(width)} ${verdict(scenario).padEnd(6)} ${passed(scenario)}`);
  return [`${"id".padEnd(4)} ${"scenario".padEnd(width)} ${"result".padEnd(6)} checks`, ...rows].join("\n");
}

export function renderMarkdown(scenarios: Scenario[]): string {
  const table = ["| id | scenario | result | checks |", "|---|---|---|---|", ...scenarios.map((scenario) => `| ${scenario.id} | ${scenario.title} | ${verdict(scenario)} | ${passed(scenario)} |`)];
  const details = scenarios.map((scenario) => {
    const lines = [`### ${scenario.id} ${scenario.title}: ${verdict(scenario)}`, ""];
    if (Object.keys(scenario.seconds).length > 0) {
      lines.push("Timings (seconds)", "", "| what | seconds |", "|---|---|", ...Object.entries(scenario.seconds).map(([key, value]) => `| ${key} | ${value} |`), "");
    }
    if (Object.keys(scenario.refs).length > 0) {
      lines.push("References", "", "| what | value |", "|---|---|", ...Object.entries(scenario.refs).map(([key, value]) => `| ${key} | \`${value}\` |`), "");
    }
    lines.push("Checks", "", ...scenario.checks.map((entry) => `- ${entry.ok ? "ok" : "**FAIL**"}: ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`), "");
    return lines.join("\n");
  });
  return [...table, "", ...details].join("\n");
}
