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

`setup.sh` prints exactly what is missing.

## Run

```
snowbridge-poc/setup.sh
```

One command from a clean machine, and idempotent: every step skips what is already done. It checks the prerequisites,
prepares the sources in `snowbridge-poc/.work` (Snowbridge `1641a286` with `stack/patches/snowbridge.patch`,
polkadot-sdk `polkadot-stable2609-2` with `stack/patches/polkadot-sdk-fulu.patch`, lodestar `v1.51.0`), builds the
fast-runtime polkadot binaries (`-j 2` under the memory cap, so the first build is slow), starts the stack, registers the
TEST token, deploys, swaps in the patched relayer and runs S1-S6 (about half an hour). The result is written to
`e2e/RESULTS.md`.

Flags: `--sources-only`, `--no-run` (stop once the stack is up), `--scenarios` (S1-S6 again on the running stack),
`--stop`, `--restart` (fresh stack, then the full flow), `--revert-relayer`, `-h`. A scenarios run spends part of
`//Alice`'s bridged TEST; after a few reruns use `--restart`.

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

A checkout that already contains a patch (for example a Snowbridge fork that has our commit) counts as patched.
Snowbridge's scripts expect `lodestar` and `go-ethereum` next to the Snowbridge checkout, so `setup.sh` links them there
when your checkouts live elsewhere.

## Stop and revert

```
snowbridge-poc/setup.sh --stop              # stops the stack
snowbridge-poc/setup.sh --revert-relayer    # stock relayer back; it then also delivers the stranger messages of S4
```
