#!/usr/bin/env bash
# Sets up and runs the whole getcash Snowbridge POC e2e suite from scratch; every step skips what is already done.
# Run with -h for the flags and the environment variables.
set -euo pipefail

POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
STACK_DIR=$POC_DIR/stack
PATCH_DIR=$STACK_DIR/patches
E2E_DIR=$POC_DIR/e2e

# shellcheck source=stack/pins.sh
source "$STACK_DIR/pins.sh"

ETHEREUM_RPC=http://127.0.0.1:8545
BEACON_HTTP=http://127.0.0.1:9596
SUBSTRATE_RPCS="http://127.0.0.1:9944 http://127.0.0.1:11144 http://127.0.0.1:12144"
HEALTHY_MARKER="starting to sync finalized headers"

say() { printf '\n== %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
die_log() { local log=$1; shift; tail -n 30 "$log" >&2 || true; die "$*"; }

usage() {
  cat <<'EOF'
Usage: snowbridge-poc/setup.sh [flag]

Without a flag: check the prerequisites, prepare the sources, build what is missing, start the local Snowbridge
stack, register the TEST token, deploy, swap in the patched relayer and run the scenarios S1-S6.

  --sources-only     stop after the checkouts (and the lodestar build) are ready
  --no-run           stop after the stack is up
  --scenarios        only run S1-S6 again on a running stack
  --stop             stop the stack
  --restart          stop the stack, then do the full flow on a fresh one
  --revert-relayer   put the stock relayer back on the running stack
  -h, --help         this text

Environment (all optional):
  GC_E2E_WORK        work dir for the checkouts and logs (default: snowbridge-poc/.work)
  SNOWBRIDGE_DIR     reuse a Snowbridge checkout (default: $GC_E2E_WORK/snowbridge)
  POLKADOT_SDK_DIR   reuse a polkadot-sdk checkout (default: $GC_E2E_WORK/polkadot-sdk)
  LODESTAR_DIR       reuse a lodestar checkout (default: $GC_E2E_WORK/lodestar)
  OUTPUT_DIR         the stack's output dir (default: /tmp/snowbridge-v2)
  GC_MEMCAP_GB       memory cap for the stack and the builds (default: 12)
  GC_STACK_TIMEOUT   seconds to wait for the stack to come up (default: 3000)
  GC_NO_NIX          1: take the Snowbridge toolchain (Go, mage, protoc, ...) from PATH instead of its Nix shell (default: 0)
EOF
}

SOURCES_ONLY=0 NO_RUN=0 SCENARIOS_ONLY=0 STOP=0 RESTART=0 REVERT=0
parse_args() {
  local arg count=0
  for arg in "$@"; do
    count=$((count + 1))
    case $arg in
      --sources-only) SOURCES_ONLY=1 ;;
      --no-run) NO_RUN=1 ;;
      --scenarios) SCENARIOS_ONLY=1 ;;
      --stop) STOP=1 ;;
      --restart) RESTART=1 ;;
      --revert-relayer) REVERT=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown flag $arg" ;;
    esac
  done
  if (( STOP + REVERT + SCENARIOS_ONLY > 0 && count > 1 )); then die "--stop, --revert-relayer and --scenarios take no other flag"; fi
}

abspath() { (cd -P "$1" && pwd); }
absolutize() { case $1 in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }

resolve_paths() {
  WORK=$(absolutize "${GC_E2E_WORK:-$POC_DIR/.work}")
  mkdir -p "$WORK/logs"
  WORK=$(abspath "$WORK")
  LOGS=$WORK/logs
  SNOWBRIDGE_DIR=$(absolutize "${SNOWBRIDGE_DIR:-$WORK/snowbridge}")
  POLKADOT_SDK_DIR=$(absolutize "${POLKADOT_SDK_DIR:-$WORK/polkadot-sdk}")
  LODESTAR_CHECKOUT=$(absolutize "${LODESTAR_DIR:-$WORK/lodestar}")
  # lodestar reads every LODESTAR_* variable as one of its own options, so the override must not reach it
  unset LODESTAR_DIR
  OUTPUT_DIR=${OUTPUT_DIR:-/tmp/snowbridge-v2}
  STACK_PROCESS_PATTERN="$OUTPUT_DIR/(bin/|zombienet/|ethereum( |\$))"
  MEMCAP_GB=${GC_MEMCAP_GB:-12}
  STACK_TIMEOUT=${GC_STACK_TIMEOUT:-3000}
  export GC_E2E_WORK=$WORK SNOWBRIDGE_DIR POLKADOT_SDK_DIR OUTPUT_DIR
  export GC_PATCHED_RELAYER=$SNOWBRIDGE_DIR/relayer/build/snowbridge-relay
}

# ---- prerequisites

MISSING=()
need() { if ! command -v "$1" >/dev/null 2>&1; then MISSING+=("$1: $2"); fi; }

check_prereqs() {
  local want_stack=$1 want_run=$2 want_build=$3 version
  MISSING=()
  need git "install git"
  need curl "install curl"
  need jq "install jq"
  if [[ $want_run == 1 ]]; then
    need node "install Node 22 or newer"
    need pnpm "install pnpm"
    need forge "install Foundry (https://getfoundry.sh)"
    need solc "install solc 0.8.30"
    if command -v node >/dev/null 2>&1; then
      version=$(node --version); version=${version#v}
      if (( ${version%%.*} < 22 )); then MISSING+=("node: found $version, need 22 or newer"); fi
    fi
    if command -v solc >/dev/null 2>&1 && [[ $(solc --version) != *"Version: 0.8.30"* ]]; then
      MISSING+=("solc: need 0.8.30, found $(solc --version | grep Version)")
    fi
  fi
  if [[ $want_stack == 1 ]]; then
    if [[ ${GC_NO_NIX:-0} == 1 ]]; then
      need go "install Go (the Snowbridge toolchain comes from PATH with GC_NO_NIX=1)"
      need mage "install mage"
      need protoc "install protobuf-compiler"
      need g++ "install a C++ compiler"
      need sponge "install moreutils"
      need direnv "install direnv"
    elif ! command -v nix >/dev/null 2>&1 && [[ ! -x /nix/var/nix/profiles/default/bin/nix ]]; then
      MISSING+=("nix: install Nix with flakes enabled (https://nixos.org/download)")
    fi
    need geth "install go-ethereum 1.17.x"
    if command -v geth >/dev/null 2>&1; then
      version=$(geth version | awk '/^Version:/ {print $2}')
      if [[ $version != 1.17.* ]]; then MISSING+=("geth: found ${version:-unknown}, need 1.17.x"); fi
    fi
    if [[ $(uname) == Darwin ]]; then need caffeinate "caffeinate ships with macOS"; fi
  fi
  if [[ $want_build == 1 ]]; then
    need cargo "install Rust with rustup (stable plus the wasm32 targets polkadot-sdk asks for)"
    need rustup "install Rust with rustup"
    need clang "install a C toolchain (Xcode command line tools on macOS)"
  fi
  if (( ${#MISSING[@]} > 0 )); then
    printf 'missing prerequisites:\n' >&2
    printf '  - %s\n' "${MISSING[@]}" >&2
    exit 1
  fi
}

# ---- sources

apply_patch() {
  local repo=$1 patch=$2 name=$3
  if git -C "$repo" apply --check -R "$patch" >/dev/null 2>&1; then info "$name patch already applied"
  elif git -C "$repo" apply --check "$patch" >/dev/null 2>&1; then
    git -C "$repo" apply "$patch"
    info "applied the $name patch"
  else die "the $name patch neither applies to nor is contained in $repo"; fi
}

is_git_checkout() { [[ -d $1/.git || -f $1/.git ]]; }

prepare_snowbridge() {
  local status
  if ! is_git_checkout "$SNOWBRIDGE_DIR"; then
    if [[ -d $SNOWBRIDGE_DIR && -n $(ls -A "$SNOWBRIDGE_DIR") ]]; then die "$SNOWBRIDGE_DIR exists and is not a git checkout"; fi
    info "cloning Snowbridge at ${SNOWBRIDGE_REV:0:8}"
    mkdir -p "$SNOWBRIDGE_DIR"
    git -C "$SNOWBRIDGE_DIR" init -q
    git -C "$SNOWBRIDGE_DIR" remote add origin "$SNOWBRIDGE_URL"
    git -C "$SNOWBRIDGE_DIR" fetch -q --depth 1 origin "$SNOWBRIDGE_REV"
    git -C "$SNOWBRIDGE_DIR" checkout -q --detach FETCH_HEAD
  elif ! git -C "$SNOWBRIDGE_DIR" merge-base --is-ancestor "$SNOWBRIDGE_REV" HEAD >/dev/null 2>&1; then
    warn "$SNOWBRIDGE_DIR does not contain Snowbridge ${SNOWBRIDGE_REV:0:8}"
  fi
  status=$(git -C "$SNOWBRIDGE_DIR" submodule status)
  if grep -q '^-' <<<"$status"; then
    info "fetching the Snowbridge contract submodules"
    git -C "$SNOWBRIDGE_DIR" submodule update --init --depth 1
  fi
  apply_patch "$SNOWBRIDGE_DIR" "$PATCH_DIR/snowbridge.patch" "Snowbridge"
}

prepare_polkadot_sdk() {
  if ! is_git_checkout "$POLKADOT_SDK_DIR"; then
    if [[ -d $POLKADOT_SDK_DIR && -n $(ls -A "$POLKADOT_SDK_DIR") ]]; then die "$POLKADOT_SDK_DIR exists and is not a git checkout"; fi
    info "cloning polkadot-sdk $POLKADOT_SDK_TAG (shallow)"
    git clone -q --depth 1 --branch "$POLKADOT_SDK_TAG" "$POLKADOT_SDK_URL" "$POLKADOT_SDK_DIR"
  fi
  apply_patch "$POLKADOT_SDK_DIR" "$PATCH_DIR/polkadot-sdk-fulu.patch" "polkadot-sdk Fulu epoch"
}

lodestar_built() {
  grep -q '^ *SLOT_DURATION_MS: 1000,' "$LODESTAR_CHECKOUT/packages/config/lib/chainConfig/configs/mainnet.js" 2>/dev/null \
    && [[ -f $LODESTAR_CHECKOUT/packages/cli/lib/index.js ]]
}

clone_lodestar() {
  if ! is_git_checkout "$LODESTAR_CHECKOUT"; then
    if [[ -d $LODESTAR_CHECKOUT && -n $(ls -A "$LODESTAR_CHECKOUT") ]]; then die "$LODESTAR_CHECKOUT exists and is not a git checkout"; fi
    info "cloning lodestar $LODESTAR_TAG (shallow)"
    git clone -q --depth 1 --branch "$LODESTAR_TAG" "$LODESTAR_URL" "$LODESTAR_CHECKOUT"
  fi
}

build_lodestar() {
  if lodestar_built; then
    info "lodestar is built with 1 s slots"
    return
  fi
  info "building lodestar with Snowbridge's own build step (1 s slots), log in $LOGS/lodestar-build.log"
  "$STACK_DIR/memcap.sh" 8 "$LOGS/lodestar-build.log" -- env REBUILD_LODESTAR=true "$STACK_DIR/relayer-go.sh" bash -c \
    'cd web/packages/test && from_start_services=true && source scripts/set-env.sh && source scripts/build-binary.sh && build_lodestar' \
    >>"$LOGS/lodestar-build.log" 2>&1 || die_log "$LOGS/lodestar-build.log" "the lodestar build failed; see $LOGS/lodestar-build.log"
  lodestar_built || die_log "$LOGS/lodestar-build.log" "lodestar did not come out built with 1 s slots; see $LOGS/lodestar-build.log"
}

# Snowbridge's scripts look for lodestar and go-ethereum next to the physical Snowbridge checkout.
ensure_sibling() {
  local name=$1 target=$2 link=$LAYOUT_DIR/$1
  if [[ -e $link || -L $link ]]; then
    if [[ $(abspath "$link") != "$(abspath "$target")" ]]; then die "$link exists and is not $target; Snowbridge's scripts need it to be"; fi
  else
    ln -s "$target" "$link"
    info "linked $link -> $target"
  fi
}

prepare_geth() {
  local path=$LAYOUT_DIR/go-ethereum/build/bin/geth
  if [[ ! -x $path ]]; then
    mkdir -p "$(dirname "$path")"
    ln -sf "$(command -v geth)" "$path"
    info "linked $path -> $(command -v geth)"
  fi
}

prepare_sources() {
  say "sources"
  prepare_snowbridge
  prepare_polkadot_sdk
  clone_lodestar
  LAYOUT_DIR=$(dirname "$(abspath "$SNOWBRIDGE_DIR")")
  ensure_sibling lodestar "$LODESTAR_CHECKOUT"
  prepare_geth
  build_lodestar
}

# ---- polkadot binaries

build_polkadot() {
  say "polkadot binaries"
  local rel=$POLKADOT_SDK_DIR/target/release bin relay_missing=0 para_stale=0
  for bin in polkadot polkadot-prepare-worker polkadot-execute-worker; do
    if [[ ! -x $rel/$bin ]]; then relay_missing=1; fi
  done
  if [[ ! -x $rel/polkadot-parachain || ! $rel/polkadot-parachain -nt $POLKADOT_SDK_DIR/$FULU_PATCHED_SOURCE ]]; then para_stale=1; fi
  if (( ! relay_missing && ! para_stale )); then
    info "the fast-runtime binaries are newer than the patched source, nothing to build"
    return
  fi
  check_prereqs 0 0 1
  local free_gb
  free_gb=$(( $(df -Pk "$POLKADOT_SDK_DIR" | awk 'NR == 2 {print $4}') / 1024 / 1024 ))
  if (( free_gb < 50 )); then warn "only $free_gb GB free next to $POLKADOT_SDK_DIR; a polkadot-sdk build needs about 50 GB"; fi
  if (( relay_missing )); then
    info "building polkadot and its workers (-j 2, under a ${MEMCAP_GB} GB cap), log in $LOGS/build-polkadot.log"
    "$STACK_DIR/memcap.sh" "$MEMCAP_GB" "$LOGS/build-polkadot.log" -- env CARGO_BUILD_JOBS=1 cargo build \
      --manifest-path "$POLKADOT_SDK_DIR/Cargo.toml" --release -j 2 \
      --bin polkadot --bin polkadot-execute-worker --bin polkadot-prepare-worker --features fast-runtime \
      || die_log "$LOGS/build-polkadot.log" "the polkadot build failed or hit the memory cap; see $LOGS/build-polkadot.log"
  fi
  if (( para_stale )); then
    info "building polkadot-parachain (-j 2, under a ${MEMCAP_GB} GB cap), log in $LOGS/build-parachain.log"
    "$STACK_DIR/memcap.sh" "$MEMCAP_GB" "$LOGS/build-parachain.log" -- env CARGO_BUILD_JOBS=1 cargo build \
      --manifest-path "$POLKADOT_SDK_DIR/Cargo.toml" --release -j 2 \
      -p polkadot-parachain-bin --bin polkadot-parachain --features fast-runtime \
      || die_log "$LOGS/build-parachain.log" "the polkadot-parachain build failed or hit the memory cap; see $LOGS/build-parachain.log"
  fi
}

# ---- the stack

rpc() { curl -fs -m 5 -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1"; }

stack_wrapper_pids() { pgrep -f '^([^ ]*/)?bash [^ ]*memcap\.sh [0-9]+ .*start-stack\.sh' || true; }
stack_running() { [[ -n $(stack_wrapper_pids) ]] || pgrep -f 'scripts/start-services\.sh' >/dev/null; }

stack_healthy() {
  local url
  rpc "$ETHEREUM_RPC" eth_blockNumber | jq -e '.result' >/dev/null 2>&1 || return 1
  for url in $SUBSTRATE_RPCS; do rpc "$url" system_health | jq -e '.result' >/dev/null 2>&1 || return 1; done
  curl -fs -m 5 "$BEACON_HTTP/eth/v1/node/health" >/dev/null 2>&1 || return 1
  grep -q "$HEALTHY_MARKER" "$OUTPUT_DIR/ethereum-relay-v3.log" 2>/dev/null || return 1
  pgrep -f "$OUTPUT_DIR/bin/snowbridge-relay run ethereum-v3" >/dev/null
}

stack_leftovers() { pgrep -f "$STACK_PROCESS_PATTERN" || true; }

stop_stack() {
  say "stopping the stack"
  local pid wrappers waited=0
  wrappers=$(stack_wrapper_pids)
  if [[ -n $wrappers ]]; then
    for pid in $wrappers; do kill -TERM "$pid" 2>/dev/null || true; done
  else
    # a stack that was not started through the memory watchdog
    pkill -TERM -f 'scripts/start-services\.sh' 2>/dev/null || true
  fi
  while (( waited < 30 )) && { stack_running || [[ -n $(stack_leftovers) ]]; }; do sleep 2; waited=$((waited + 2)); done
  if [[ -n $(stack_leftovers) ]]; then
    warn "stopping leftover stack processes"
    pkill -KILL -f "$STACK_PROCESS_PATTERN" 2>/dev/null || true
    sleep 2
  fi
  if rpc "$ETHEREUM_RPC" eth_blockNumber >/dev/null 2>&1; then die "something still answers on $ETHEREUM_RPC after the stop"; fi
  info "stopped"
}

start_stack() {
  local launcher
  launcher=("$STACK_DIR/memcap.sh" "$MEMCAP_GB" "$LOGS/stack-memcap.log" -- env REBUILD_LODESTAR=false "$STACK_DIR/start-stack.sh")
  if command -v caffeinate >/dev/null 2>&1; then launcher=(caffeinate -i "${launcher[@]}"); fi
  info "starting the stack under a ${MEMCAP_GB} GB cap; output in $LOGS/stack.log"
  # own process group: the stack's cleanup runs `kill 0`
  set -m
  nohup "${launcher[@]}" >"$LOGS/stack.log" 2>&1 </dev/null &
  STACK_LAUNCH_PID=$!
  set +m
}

# a stack that was just launched is not visible to pgrep for a moment, so ask its launcher
stack_alive() {
  if [[ -n ${STACK_LAUNCH_PID:-} ]]; then kill -0 "$STACK_LAUNCH_PID" 2>/dev/null; else stack_running; fi
}

wait_for_stack() {
  local started=$SECONDS last=$SECONDS
  until stack_healthy; do
    stack_alive || die "the stack exited before it was ready; see $LOGS/stack.log and $LOGS/stack-memcap.log"
    if (( SECONDS - started > STACK_TIMEOUT )); then die "the stack was not ready after $STACK_TIMEOUT s; see $LOGS/stack.log"; fi
    if (( SECONDS - last >= 60 )); then info "waiting for the stack, $((SECONDS - started)) s"; last=$SECONDS; fi
    sleep 5
  done
  info "the stack is up after $((SECONDS - started)) s (Ethereum relayer: $HEALTHY_MARKER)"
}

ensure_stack() {
  say "stack"
  if stack_healthy; then
    info "the stack is already running and healthy"
    return
  fi
  if stack_running; then
    info "a stack is running but not healthy yet, waiting for it"
  else
    start_stack
  fi
  wait_for_stack
}

# ---- the e2e flow

pnpm_in() { local dir=$1; shift; CI=true pnpm --dir "$POC_DIR/$dir" "$@"; }

install_packages() {
  local pkg
  for pkg in assethub services e2e; do
    if [[ -f $POC_DIR/$pkg/node_modules/.modules.yaml && $POC_DIR/$pkg/node_modules/.modules.yaml -nt $POC_DIR/$pkg/pnpm-lock.yaml ]]; then continue; fi
    info "installing the $pkg packages"
    pnpm_in "$pkg" install --frozen-lockfile
  done
}

deployment_valid() {
  local file=$E2E_DIR/deployments/local.json tx
  [[ -f $file && -f $E2E_DIR/.env.local ]] || return 1
  tx=$(jq -r '.registryDeployTx // empty' "$file") || return 1
  [[ -n $tx ]] || return 1
  [[ -n $(rpc "$ETHEREUM_RPC" eth_getTransactionByHash "[\"$tx\"]" | jq -r '.result // empty') ]]
}

relayer_patched() { jq -e 'has("getcash")' "$OUTPUT_DIR/ethereum-v3.json" >/dev/null 2>&1; }

run_flow() {
  say "packages and contracts"
  install_packages
  forge build --root "$POC_DIR/eth" -q

  say "TEST token"
  pnpm_in e2e exec tsx src/registerToken.ts

  say "deployment"
  if deployment_valid; then
    info "the deployment in e2e/deployments/local.json is on this chain, keeping it"
  else
    if relayer_patched; then die "the patched relayer is running but there is no valid deployment, and the deploy needs the stock relayer; run with --restart"; fi
    pnpm_in e2e run deploy
  fi

  say "patched relayer"
  pnpm_in e2e run relayer swap

  run_scenarios
}

run_scenarios() {
  say "scenarios S1-S6 (about half an hour)"
  local status=0
  pnpm_in e2e run scenarios || status=$?
  say "results"
  info "$E2E_DIR/RESULTS.md"
  grep -E '^\| S[0-9] ' "$E2E_DIR/RESULTS.md" || true
  if (( status != 0 )); then die "the scenarios did not all pass (exit $status); see $E2E_DIR/RESULTS.md and $E2E_DIR/data"; fi
}

main() {
  parse_args "$@"
  resolve_paths

  if (( STOP )); then stop_stack; return; fi

  if (( REVERT )); then
    check_prereqs 0 1 0
    say "reverting to the stock relayer"
    pnpm_in e2e install --frozen-lockfile
    pnpm_in e2e run relayer revert
    return
  fi

  if (( SCENARIOS_ONLY )); then
    check_prereqs 0 1 0
    [[ -f $SNOWBRIDGE_DIR/web/packages/test/scripts/set-env.sh ]] || die "no Snowbridge checkout at $SNOWBRIDGE_DIR; run setup.sh without a flag first"
    stack_healthy || die "no healthy stack; run setup.sh without a flag first"
    deployment_valid || die "no deployment on this chain; run setup.sh without a flag first"
    say "packages and contracts"
    install_packages
    forge build --root "$POC_DIR/eth" -q
    say "patched relayer"
    pnpm_in e2e run relayer swap
    run_scenarios
    return
  fi

  local want_run=1
  if (( SOURCES_ONLY || NO_RUN )); then want_run=0; fi
  check_prereqs 1 "$want_run" 0
  prepare_sources
  if (( SOURCES_ONLY )); then return; fi

  if (( RESTART )); then stop_stack; fi
  if ! stack_healthy && ! stack_running; then build_polkadot; fi
  ensure_stack
  if (( NO_RUN )); then return; fi

  run_flow
}

main "$@"
