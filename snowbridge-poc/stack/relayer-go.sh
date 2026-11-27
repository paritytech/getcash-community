#!/usr/bin/env bash
# Runs a command inside the Snowbridge checkout's Nix shell (Go, mage and node live only there). The shell hook keys off $PWD.
# Required env: SNOWBRIDGE_DIR. Usage: relayer-go.sh <command> [args...]
set -euo pipefail

: "${SNOWBRIDGE_DIR:?SNOWBRIDGE_DIR is required}"
nix_bin=$(command -v nix || echo /nix/var/nix/profiles/default/bin/nix)

cd "$SNOWBRIDGE_DIR"
exec "$nix_bin" --extra-experimental-features "nix-command flakes" develop "$SNOWBRIDGE_DIR" --command "$@"
