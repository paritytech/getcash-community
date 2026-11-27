#!/usr/bin/env bash
# Starts Snowbridge's local test stack in the Snowbridge toolchain (see relayer-go.sh).
# The toolchain's hook and set-env.sh key off the working directory, so this starts from the checkout root.
# Required env: SNOWBRIDGE_DIR, POLKADOT_SDK_DIR (absolute). OUTPUT_DIR, REBUILD_LODESTAR, REBUILD_WEB_API and GC_NO_NIX pass through.
set -euo pipefail

stack_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${SNOWBRIDGE_DIR:?SNOWBRIDGE_DIR is required}"
: "${POLKADOT_SDK_DIR:?POLKADOT_SDK_DIR is required}"
export POLKADOT_SDK_DIR GC_STACK_DIR="$stack_dir"

exec "$stack_dir/relayer-go.sh" bash -c '
    set -euo pipefail
    # Nix ps (adv_cmds) exits 1 on macOS ("requires entitlement"), so zombienet thinks every node died
    if [ "$(uname)" = Darwin ] && [ "${GC_NO_NIX:-0}" != 1 ]; then export PATH="$GC_STACK_DIR/bin:$PATH"; fi
    if ! command -v sszgen >/dev/null; then
        go install "github.com/ferranbt/fastssz/sszgen@$(go -C relayer list -m -f "{{.Version}}" github.com/ferranbt/fastssz)"
    fi
    cd web/packages/test
    export REBUILD_WEB_API="${REBUILD_WEB_API:-true}"
    exec scripts/start-services.sh'
