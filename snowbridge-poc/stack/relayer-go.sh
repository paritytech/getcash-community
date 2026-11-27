#!/usr/bin/env bash
# Runs a command in the Snowbridge toolchain: the checkout's Nix shell (Go, mage and node live only there; its hook keys off $PWD),
# or, with GC_NO_NIX=1, the same environment with the tools taken from PATH (the Docker image does this), where
# GC_TOOLCHAIN_PATH puts a directory in front of PATH for tools that must differ from the ones outside (a newer forge).
# Required env: SNOWBRIDGE_DIR. Usage: relayer-go.sh <command> [args...]
set -euo pipefail

: "${SNOWBRIDGE_DIR:?SNOWBRIDGE_DIR is required}"

cd "$SNOWBRIDGE_DIR"
if [[ ${GC_NO_NIX:-0} == 1 ]]; then
  export GOCACHE=$SNOWBRIDGE_DIR/gocache GOPATH=$SNOWBRIDGE_DIR/go
  export PATH=${GC_TOOLCHAIN_PATH:+$GC_TOOLCHAIN_PATH:}$GOPATH/bin:$PATH
  exec "$@"
fi
nix_bin=$(command -v nix || echo /nix/var/nix/profiles/default/bin/nix)
exec "$nix_bin" --extra-experimental-features "nix-command flakes" develop "$SNOWBRIDGE_DIR" --command "$@"
