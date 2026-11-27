# Findings for the design

What the POC showed that `relayer-and-pool-contract.md` does not say yet. Evidence: `assethub/FACTS.md`,
`e2e/RESULTS.md`, and the tests in each package. Measured on the local stack (asset-hub-westend,
polkadot-stable2609-2) on 2026-11-26/27.

## Confirmed as designed

- A Snowbridge message can `Transact` into `Revive.call` on Asset Hub, and the pool's `settle` runs with
  the router as caller (to-verify 2). Proven by real deliveries.
- No other Ethereum sender can `AliasOrigin` into the router's location (to-verify 4).
- A contract can pay a user with the XCM precompile's `execute(TransferAsset)` (to-verify 5).
- `isOurs` (origin = router, tx signer = trigger key valid at that tx) delivers ours and ignores a direct
  Gateway message and a stranger's own forwarder. A trigger-key rotation in flight needs no restart and
  no config change: the old key's message is still delivered. A restart catches up.
- Fronted user paid 6 to 10 s after their transfer. Settlement 87 to 135 s locally (local finality
  about 2 min; mainnet adds about 16 min).

## Changes the design needs

1. **Router: one token per pool.** `settle` with any other token charges the bridge fee in the wrong
   units, and a Polkadot-native token gets stranded in the pool. The router refuses other tokens, so a
   stray token stays in the forwarder for the owner's `withdraw`.
2. **Router: one `send` per transaction.** A registered token with callbacks can nest a stranger's
   trigger inside the trigger key's transaction, and the relayer would treat it as ours. A transient
   lock in the router refuses a second send.
3. **Deposit id per forwarder**, `keccak(forwarder, n)`, not a global counter. A reorg can otherwise
   swap two ids and make both fronts mismatch.
4. **Fronts keyed by `(depositId, account, token, amount)`.** Keyed by id alone, anyone can block the
   fast path of any (predictable) deposit for free. Residual: a stranger can still front the exact
   deposit first at the maximum fee, bounded by the front-fee cap.
5. **`settle` must never revert on a failed payout.** Bridged USDT/USDC-like foreign assets are not
   sufficient, so paying a user whose Asset Hub account does not exist fails. The pool records it as
   `owed`, and anyone can `claim` it later to that same account.
6. **`ExpectTransactStatus(Success)` after the `Transact`.** A failed `Transact` does not fail the XCM:
   the tokens land in the pool and nothing records them. With the guard a dry-run reports `Incomplete`,
   so a dry-run-gated relayer holds the message on Ethereum. A relayer that delivers without a dry-run
   still strands the tokens, so `resend` / `settleFromSurplus` (to-verify 6) is needed before real money.
7. **The router's Asset Hub account pays storage deposits** (132M to 528M planck per `settle`). If it
   runs dry, every `settle` fails. Keep it funded and alert on it.
8. **No `map_account` setup message** on this runtime: `AutoMap` is on. Check Polkadot Asset Hub.
9. **Claimer must name the relay network** (`ByGenesis(westend)` here, `Polkadot` on mainnet). A claimer
   with network `None` is not claimable by the user.
10. **The payout service fronts only deposits our relayer will deliver**: same rule as `isOurs`.
    Otherwise a stranger's own forwarder gets fronted and never settles.
11. **The relayer's Asset Hub dry-run only runs with gas estimation on**, which needs Snowfork's Rust
    estimator binary. Without it there is no failing-dry-run alert.
12. **Trigger service:** a per-token minimum (dust otherwise drains the trigger key), and a re-quoted
    execution fee (a fixed fee strands deposits when the ETH/DOT rate moves).

## Measured numbers (local)

- Router program: 38.8e9 ref time / 0.9M proof; execution fee quote about 2.8e11 wei.
- `settle`: about 1.07e9 / 52k (paid), 1.31e9 / 72k (user owed), 1.50e9 / 83k (both owed). Router weight
  limit 2.5e9 / 150k gives about 1.7x headroom.

## Production gaps (not built)

Outbound `isOurs`; `resend` / `settleFromSurplus`; dotUSD payout; registration auth and rate limits;
replacing stuck trigger transactions; an archive node or indexer for the payout service's history; the
forge deploy key on the command line; Snowbridge's local e2e needs Snowfork's polkadot-sdk or a Fulu
epoch patch on paritytech releases.
