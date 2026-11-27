# Snowbridge relayer POC

Proof of concept of an Ethereum to Asset Hub deposit path on Snowbridge: a forwarder, factory, registry and router on
Ethereum, a pool contract on Asset Hub that fronts the user's payout, a trigger service, a payout service, and a patched
Snowbridge relayer that delivers only our router's messages. `e2e/` proves it with six scenarios (S1-S6) on a local
Snowbridge stack. Findings for the design are in [FINDINGS.md](FINDINGS.md), the plan and interfaces in
[PLAN.md](PLAN.md), the last run in [e2e/RESULTS.md](e2e/RESULTS.md).

This directory is self-contained and not part of the app's pnpm workspace. Each package (`assethub`, `services`, `e2e`)
has its own lockfile.

## Prerequisites

- macOS or Linux, about 50 GB of free disk for the polkadot-sdk build, and a 12 GB memory cap for the stack and the builds
- Nix with flakes (the Snowbridge checkout's dev shell provides Go, mage and the Snowbridge toolchain)
- Foundry and solc 0.8.30
- Node 22 or newer and pnpm
- geth 1.17.x
- Rust through rustup, only when the polkadot binaries have to be built (first run, or after the Fulu patch changes)

`setup.sh` prints exactly what is missing. To skip all of this, use [Docker](#docker).

## Run

```
snowbridge-poc/setup.sh
```

One command from a clean machine, and idempotent: every step skips what is already done. It checks the prerequisites,
prepares the sources in `snowbridge-poc/.work` (Snowbridge `1641a286` with `stack/patches/snowbridge.patch`,
polkadot-sdk `polkadot-stable2609-2` with `stack/patches/polkadot-sdk-fulu.patch`, lodestar `v1.51.0`; the pins are in
`stack/pins.sh`), builds the fast-runtime polkadot binaries (`-j 2` under the memory cap, so the first build is slow),
starts the stack, registers the TEST token, deploys, swaps in the patched relayer and runs S1-S6 (about half an hour).
The result is written to `e2e/RESULTS.md`.

Flags: `--sources-only`, `--no-run` (stop once the stack is up), `--scenarios` (S1-S6 again on the running stack),
`--stop`, `--restart` (fresh stack, then the full flow), `--revert-relayer`, `-h`. A scenarios run spends part of
`//Alice`'s bridged TEST; after a few reruns use `--restart`.

## Docker

```
docker build -t getcash-sb-e2e snowbridge-poc
docker run --rm --memory 12g -v "$PWD/out:/out" getcash-sb-e2e
```

The image holds everything the flow needs: the fast-runtime polkadot binaries, the patched Snowbridge with its contracts,
relayer and web packages built, lodestar, geth, Foundry, solc, Node and the POC. The container runs `setup.sh` (arguments
pass through, for example `--no-run`), exits 0 only when S1-S6 all pass, and copies `RESULTS.md`, the setup logs and the
stack's logs to `/out`. Inside, `GC_NO_NIX=1` replaces the Nix shell and the memory cap is 11 GB. A run takes about
20 minutes.

The first build compiles polkadot-sdk at `-j 2` and solc 0.8.30 from source (there is no official linux-arm64 binary
before 0.8.31): about two hours on an 8-CPU Apple silicon VM. The image is 8.1 GB and the build cache about 47 GB, kept
so that a POC change rebuilds only the last stage, in seconds. Keep 60 GB free on the host: a VM's disk file grows and does not
shrink on its own, and a host that runs out of disk corrupts the VM's filesystems.

On Colima the default builder did not reuse layers between builds and pruned the cargo cache, so build with a
`docker-container` builder that never garbage-collects:

```
docker buildx create --name gc-builder --driver docker-container --buildkitd-config snowbridge-poc/docker/buildkitd.toml
docker buildx build --builder gc-builder --load -t getcash-sb-e2e snowbridge-poc
```

Without the buildx plugin on the host, run these inside the VM (`colima ssh -- docker buildx ...`).

## Reuse existing checkouts

| Variable | Meaning | Default |
|---|---|---|
| `GC_E2E_WORK` | work dir for checkouts and logs (gitignored) | `snowbridge-poc/.work` |
| `SNOWBRIDGE_DIR` | Snowbridge checkout | `$GC_E2E_WORK/snowbridge` |
| `POLKADOT_SDK_DIR` | polkadot-sdk checkout | `$GC_E2E_WORK/polkadot-sdk` |
| `LODESTAR_DIR` | lodestar checkout | `$GC_E2E_WORK/lodestar` |
| `OUTPUT_DIR` | the stack's output dir | `/tmp/snowbridge-v2` |
| `GC_MEMCAP_GB` | memory cap | `12` |
| `GC_STACK_TIMEOUT` | seconds to wait for the stack | `3000` |
| `GC_NO_NIX` | `1` takes Go, mage, protoc and the rest of the Snowbridge toolchain from `PATH` instead of its Nix shell (the Docker image does) | `0` |
| `GC_TOOLCHAIN_PATH` | with `GC_NO_NIX=1`, a directory put first on `PATH` for Snowbridge's scripts only | unset |

A checkout that already contains a patch (for example a Snowbridge fork that has our commit) counts as patched.
Snowbridge's scripts expect `lodestar` and `go-ethereum` next to the Snowbridge checkout, so `setup.sh` links them there
when your checkouts live elsewhere.

## Stop and revert

```
snowbridge-poc/setup.sh --stop              # stops the stack
snowbridge-poc/setup.sh --revert-relayer    # stock relayer back; it then also delivers the stranger messages of S4
```
