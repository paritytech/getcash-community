# Services

Three programs in one package: the trigger service (`pnpm trigger`), the payout service (`pnpm payout`) and the user stand-in CLI (`pnpm user`). `pnpm test` runs everything hermetically against a local anvil; `pnpm typecheck` checks the types.

## Keys and env files

Each program reads its own env file and takes only its own variables from it, so a secret in one file never lands in another process.

| Program | Env file (default) | Secret | Variables taken from the file |
|---|---|---|---|
| trigger | `ENV_FILE` (`.env`) | `TRIGGER_KEY` | the list in `.env.example` |
| payout | `PAYOUT_ENV_FILE` (`.env.payout`) | `PAYER_SEED` | the list in `.env.payout.example` |
| user CLI | `USER_ENV_FILE` (`.env.user`, then `.env`) | `USER_SEED` | `USER_SEED`, `FACTORY_ADDRESS`, `RPC_URL`, `TRIGGER_URL` |

- Variables already set in the process win over the file, as before.
- At startup each program also removes the other programs' secrets from its own `process.env`.
- The trigger key is read from its env file first, then from the process environment, and is deleted from `process.env` after every read. SIGHUP re-reads it the same way, so a rotation needs the key in the env file. A key that was only in the shell's environment cannot be rotated without a restart.

## Trigger service

Triggers a forwarder when it holds an allowlisted token. What it checks, and what it refuses:

- **Startup.** Every `TOKEN_ALLOWLIST` entry must equal `router.TOKEN()`, otherwise it does not start. Every stored registration is compared with `factory.predict`; a mismatch is logged as an error (`alert: registration-mismatch`), counted as `quarantined` in `/status` and never triggered, but not deleted.
- **Dust.** A balance below `MIN_TRIGGER_AMOUNT` is left alone: no deploy, no trigger. The default is one whole token at the token's `decimals()`, and the service refuses to start when it cannot read them and no minimum is set. Keep the minimum well above the pool's bridge fee.
- **Execution fee.** Before every trigger, and every `QUOTE_INTERVAL_MS` in between, it asks Asset Hub's `XcmPaymentApi` what delivering the message costs (the same program and pricing as `assethub/src/fees.ts`). A trigger is **refused** while `EXECUTION_FEE_WEI` is below the quote times `EXECUTION_FEE_MARGIN`; the fee actually sent is always the configured one. When Asset Hub cannot be reached it keeps using the last good quote for `QUOTE_MAX_AGE_MS`, then refuses. Refusals are error logs with `alert: execution-fee`; `/status` shows the configured fee, the quote and the required fee.

| New variable | Default |
|---|---|
| `ASSET_HUB_WS` | `ws://127.0.0.1:12144` |
| `MIN_TRIGGER_AMOUNT` | one whole token per token (integer for all tokens, or `token=amount` pairs) |
| `EXECUTION_FEE_MARGIN` | `1.2` (at least `1`) |
| `QUOTE_INTERVAL_MS` | `60000` |
| `QUOTE_MAX_AGE_MS` | `300000` |
| `QUOTE_TIMEOUT_MS` | `15000` |

## Payout service

Fronts a deposit on Asset Hub only when all of these hold: the `Sent` event is from the router, the transaction that emitted it was signed by the registry's relayer **as it was at that transaction** (read from the registry's `relayer()` before the block plus the `RelayerChanged` logs of the same block, ordered by transaction index, exactly as the relayer's `isOurs` does), and the pool has no front or settlement for the deposit yet. Anything else is recorded as `skipped`, for a stranger's deposit with the reason `not triggered by our key`. If the signer or the relayer of that moment cannot be established, nothing is fronted and the deposit is retried.

The registry address is read from `router.FACTORY().REGISTRY()`, so it matches the relayer's `getcash.registry` as long as both follow the same router. The Ethereum node must keep historical state (archive) for `relayer()` at the block before a deposit.

- **A front that never reports back.** Waiting for inclusion ends after `SUBMIT_TIMEOUT_MS`, when the Asset Hub socket drops, or when the service stops, with a transport error. The next attempt reads the pool's state before it does anything, so a late-landing extrinsic is adopted and never repeated. `stop()` does not wait for a front.
- **Bookkeeping.** A refused front (`AlreadyFronted`, `AlreadySettled`) is decided by reading the pool again: this payer's own front is `fronted`, a stranger's is `skipped`. A settlement is `repaid` only when `Settled.to` is this payer; a repayment to anyone else on a deposit recorded as fronted is an `unrepaid` alert. A repayment to this payer settles the record whatever status it had, since the money came back.
- **Pruned Asset Hub state.** Asset Hub keeps state about 200 blocks. When settlement events of a block cannot be read (`alert: events-lost`), every `fronted` record is checked against the pool's `state(key)` on the next pass (repeated until it succeeds): settled and fronted by this payer is `repaid`, settled otherwise is an `unrepaid` alert, still fronted stays outstanding.
- **Gave up.** A deposit that failed on transport errors is queued again `FAILED_RETRY_MS` after it gave up, on the next pass in which nothing else failed.
- **Unsettled.** A `fronted` deposit still unsettled `UNSETTLED_ALERT_MINUTES` after its Ethereum block was first seen finalized raises an error log with `alert: unsettled`, and again every that many minutes.
- **Reused ids.** A deposit id that reappears with a different account, token or amount is an error log (`alert: deposit-id-reused`); the first record is kept.
- Log lines and `/status` carry viem's short messages only, with any URL cut to its origin, because RPC URLs can hold API keys.

| New variable | Default |
|---|---|
| `PAYOUT_ENV_FILE` | `.env.payout` |
| `SUBMIT_TIMEOUT_MS` | `60000` |
| `FAILED_RETRY_MS` | `60000` |
| `UNSETTLED_ALERT_MINUTES` | `30` (`0` turns it off) |

### Starting without a state file

A store without an Ethereum cursor means the service has no record of what it has already seen, so it refuses to start unless `START_BLOCK` is set. This applies to a first start and to a lost or deleted state file.

To rebuild outstanding exposure after losing the state file:

1. Set `START_BLOCK` to the earliest block that can hold a deposit this payer fronted and that is not settled yet. The router's deploy block is always safe.
2. Start the service. It rescans the router's `Sent` events from there and reads the pool's record of every deposit before it acts: a front by this payer that is still open is adopted as `fronted` and counts toward `maxOutstanding` again, a settled one becomes `repaid`, anything else is left alone. Nothing is fronted twice, because the pool keys fronts by deposit id, account, token and amount.
3. Compare `caps.outstanding` in `/status` with the payer's `funds` in the pool before relying on the caps.
4. A state file restored from an older backup needs no action: deposits fronted since the backup are found again and adopted the same way.

Settlements that happened while the service was down are not replayed from events (Asset Hub prunes them); the pool-state reads above decide them.

## Production gaps not fixed in the POC

- Registration is unauthenticated, and the trigger service polls every registered forwarder's balance on every tick. At scale it needs authentication or rate limits on `POST /deposits`, and `Transfer` logs of the allowlisted token instead of polling balances.
- A trigger transaction that stays pending is not replaced. Production needs same-nonce replacement with a higher fee, and a `maxFeePerGas` cap so a fee spike cannot drain the trigger key.
- Rebuilding outstanding exposure after state loss needs an archive node or an indexer: the scan above only works as far back as the Ethereum node serves logs and historical state, and Asset Hub history older than its pruning window is only visible through the pool's current state.
- The unsettled alert counts from the moment the service first saw the deposit's block finalized, so it under-counts after downtime.
