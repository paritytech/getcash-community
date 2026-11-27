#!/usr/bin/env bash
# Container entrypoint: runs setup.sh (the full flow, or the flag it is given), then copies RESULTS.md and the logs to /out.
# The exit status is setup.sh's: 0 only when every scenario passed.
set -uo pipefail

POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
out=${GC_OUT_DIR:-/out}
logs=${GC_E2E_WORK:?GC_E2E_WORK is required}/logs

status=0
"$POC_DIR/setup.sh" "$@" || status=$?

if [[ -d $out ]]; then
  mkdir -p "$out/logs" "$out/stack-logs"
  cp -f "$POC_DIR/e2e/RESULTS.md" "$out/" 2>/dev/null || true
  cp -rf "$logs/." "$out/logs/" 2>/dev/null || true
  cp -f "${OUTPUT_DIR:-/tmp/snowbridge-v2}"/*.log "$out/stack-logs/" 2>/dev/null || true
  cp -rf "$POC_DIR/e2e/data" "$out/" 2>/dev/null || true
fi

if (( status != 0 )); then
  for log in stack.log stack-memcap.log; do
    if [[ -f $logs/$log ]]; then printf '\n== tail of %s\n' "$log" >&2; tail -n 40 "$logs/$log" >&2; fi
  done
fi
exit "$status"
