// Where the pages for developers may show: on the preview of a pull request, which is published
// under a name that starts with `pr` and its number, and on a copy a developer serves. A
// released app never shows them.

import { environmentFor, type Served } from "~~/lib/telemetry/environment";

export function isPreviewOrLocal(served: Served): boolean {
  const { environment, source } = environmentFor(served);
  return source === "local" || /^pr\d+-/.test(environment);
}
