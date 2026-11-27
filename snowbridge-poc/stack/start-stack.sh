#!/usr/bin/env bash
# Starts Snowbridge's local test stack inside the Snowbridge checkout's Nix shell.
# The shell hook keys its caches and set-env.sh off the working directory, so this starts from the checkout root.
# Required env: SNOWBRIDGE_DIR, POLKADOT_SDK_DIR (absolute). OUTPUT_DIR, REBUILD_LODESTAR and REBUILD_WEB_API pass through.
set -euo pipefail

stack_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${SNOWBRIDGE_DIR:?SNOWBRIDGE_DIR is required}"
: "${POLKADOT_SDK_DIR:?POLKADOT_SDK_DIR is required}"
export POLKADOT_SDK_DIR GC_STACK_DIR="$stack_dir"
nix_bin=$(command -v nix || echo /nix/var/nix/profiles/default/bin/nix)

cd "$SNOWBRIDGE_DIR"
exec "$nix_bin" --extra-experimental-features "nix-command flakes" develop "$SNOWBRIDGE_DIR" --command bash -c '
    set -euo pipefail
    # Nix ps (adv_cmds) exits 1 on macOS ("requires entitlement"), so zombienet thinks every node died
    if [ "$(uname)" = Darwin ]; then export PATH="$GC_STACK_DIR/bin:$PATH"; fi
    if ! command -v sszgen >/dev/null; then
        go install "github.com/ferranbt/fastssz/sszgen@$(go -C relayer list -m -f "{{.Version}}" github.com/ferranbt/fastssz)"
    fi
    cd web/packages/test
    export REBUILD_WEB_API="${REBUILD_WEB_API:-true}"
    exec scripts/start-services.sh'
