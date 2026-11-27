#!/usr/bin/env bash
# Image build step: does what the stack would otherwise build or download on every start (the Snowbridge contracts, the relayer,
# the web packages), so that a container run needs no network. Required env: SNOWBRIDGE_DIR.
set -euo pipefail

: "${SNOWBRIDGE_DIR:?SNOWBRIDGE_DIR is required}"
POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

OUTPUT_DIR=$(mktemp -d)
mkdir "$OUTPUT_DIR/bin"
export OUTPUT_DIR REBUILD_WEB_API=true

"$POC_DIR/stack/relayer-go.sh" bash -c '
    set -euo pipefail
    if ! command -v sszgen >/dev/null; then
        go install "github.com/ferranbt/fastssz/sszgen@$(go -C relayer list -m -f "{{.Version}}" github.com/ferranbt/fastssz)"
    fi
    cd web/packages/test
    from_start_services=true
    source scripts/set-env.sh
    source scripts/build-binary.sh
    build_contracts
    build_relayer
    build_web_packages'

rm -r "$OUTPUT_DIR"
