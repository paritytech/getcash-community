#!/usr/bin/env bash
#
# deploy.sh: build and publish the static app to bulletin/DotNS.
#
# Usage:   ./deploy.sh [name.paseo]
# Default: getcash.paseo
#
# Required env: MNEMONIC (the deploying account).
# The name carries the environment's TLD: paseo-next-v2 serves ".paseo".
set -euo pipefail

NAME="${1:-getcash.paseo}"
OUT=".output/public"

# Deployer seed: MNEMONIC env wins; otherwise read VITE_DEPLOYER_SEED from .env.local or .env.
if [ -z "${MNEMONIC:-}" ]; then
  for f in .env.local .env; do
    if [ -f "$f" ]; then
      line="$(grep -m1 '^VITE_DEPLOYER_SEED=' "$f" || true)"
      if [ -n "$line" ]; then
        MNEMONIC="${line#VITE_DEPLOYER_SEED=}"
        MNEMONIC="${MNEMONIC%\"}"; MNEMONIC="${MNEMONIC#\"}"
        MNEMONIC="${MNEMONIC%\'}"; MNEMONIC="${MNEMONIC#\'}"
        export MNEMONIC
        break
      fi
    fi
  done
fi
if [ -z "${MNEMONIC:-}" ]; then
  echo "Error: set MNEMONIC or VITE_DEPLOYER_SEED (.env.local/.env)." >&2
  exit 1
fi

# The nuxt build copies the worker bundle into the site; build the worker first.
pnpm build:worker
pnpm build
# bulletin-deploy.config.ts reads the deploy target from this variable.
DEPLOY_DOMAIN="$NAME" bulletin-deploy "$OUT" "$NAME" --env paseo-next-v2 --js-merkle
