# getcash Snowbridge POC

End-to-end proof of concept of the getcash relayer and pool contract design (the design document is not
part of this repository). This file is the shared plan for every worker and reviewer. The design document
wins on intent; this file wins on interfaces and scope. `setup.sh` builds and runs the whole suite; see
`README.md`.

## Scope

In: inbound only (Ethereum to Asset Hub). Forwarder, factory, registry, router on Ethereum; pool
contract on Asset Hub; our relayer patch (`ethereum-v3` `isOurs`); trigger service; payout
(fronting) service; e2e scenarios on the local stack.

Deferred (record, do not build): outbound `isOurs` in `parachain-v3`; `router.resend` and
`pool.settleFromSurplus`; dotUSD payout asset (the POC pays the bridged token itself); guardian
fee setting beyond immutable caps; hot standby.

## Layout

| Path | What | Toolchain |
|---|---|---|
| `eth/` | Foundry project: `Registry`, `ForwarderFactory`, `Forwarder`, `Router` | forge, solc |
| `assethub/` | Pool contract (Solidity, EVM bytecode on pallet-revive) + TS tools: XCM template builder, deploy, dry-run | solc, node, pnpm |
| `services/` | TS trigger service and payout service | node, pnpm, viem |
| `e2e/` | Scenario scripts against the local stack | node, pnpm |
| `stack/` | Local stack scripts and the patches for Snowbridge (our relayer patch, Go) and polkadot-sdk | Nix devShell |

## Local stack

Started by `setup.sh` through `stack/start-stack.sh` under a 12 GB memory watchdog. `OUTPUT_DIR` defaults to
`/tmp/snowbridge-v2`; `SNOWBRIDGE_DIR` and `POLKADOT_SDK_DIR` are the checkouts `setup.sh` prepares.

| Thing | Where |
|---|---|
| Ethereum execution (geth 1.17.1, chain id 11155111) | http://127.0.0.1:8545, ws://127.0.0.1:8546 |
| Beacon (Lodestar dev, 1 s slots, Fulu from epoch 0) | http://127.0.0.1:9596 |
| Relay chain | ws://127.0.0.1:9944 |
| Bridge Hub (para 1002) | ws://127.0.0.1:11144 |
| Asset Hub (para 1000, asset-hub-westend fast-runtime, pallet-revive with `AllowEVMBytecode = true`) | ws://127.0.0.1:12144 |
| Snowbridge contracts | `$OUTPUT_DIR/contracts.json` (GatewayProxy `0xb1185ede04202fe62d38f5db72f71e38ff3e8305`, WETH9, a test `Token`) |
| Funded dev keys | `$SNOWBRIDGE_DIR/web/packages/test/scripts/set-env.sh` (`PRIVATE_KEY` deployer on geth; `//Alice` etc. on the parachains) |
| Relayer logs | `$OUTPUT_DIR/*.log` |
| Snowbridge contract sources (Gateway v2) | `$SNOWBRIDGE_DIR/contracts/src/v2/` |
| Runtime sources | `$POLKADOT_SDK_DIR` (polkadot-stable2609-2 plus `stack/patches/polkadot-sdk-fulu.patch`) |

The stack's stock `ethereum-v3` relayer currently delivers every inbound message. Our patched relayer
replaces it in the e2e milestone, not before.

## Interfaces (fixed; change only through the supervisor)

Ethereum (`eth/`):

- `Registry`: `admin`, `relayer` (the trigger key), `guardian`, `paused`. `setRelayer(address)` by
  admin emits `RelayerChanged(address relayer)`. `setPaused(bool)` by guardian.
- `ForwarderFactory(registry, gateway, token, xcmHead, xcmTail, claimerHead)` deploys the `Router`
  (immutable `TOKEN`; `send` reverts `TokenNotAllowed` for any other token, so a stray token stays in
  the forwarder for the owner's `withdraw`) in its
  constructor (`factory.ROUTER()`): `predict(account, owner)`, `deploy(account, owner)` open to
  anyone, `isForwarder(address) -> bool`. CREATE2 salt `keccak256(abi.encode(account, owner))`.
  `gateway` is the GatewayProxy.
- `Forwarder`: immutable `ACCOUNT` (bytes32 Asset Hub account), `OWNER`, `FACTORY`, `REGISTRY`,
  `ROUTER`. `trigger(address token, uint128 executionFee, uint128 relayerFee) payable`, callable by
  `registry.relayer()` or `OWNER`, reverts `NotRelayerOrOwner`; reverts when paused; approves the
  router for its whole balance of `token` and calls `router.send{value: msg.value}(token, amount,
  executionFee, relayerFee)`. `withdraw(token, to, amount, deadline, signature)` with an EIP-712
  signature by `OWNER`, submittable by anyone.
- `Router(gateway, factory, xcmHead, xcmTail, claimerHead)`: no admin. `send(token, amount,
  executionFee, relayerFee) payable` requires `factory.isForwarder(msg.sender)`, reads `ACCOUNT`
  from the forwarder, pulls `amount` of `token`, allows only one `send` per transaction (transient
  lock, so a token callback cannot nest a stranger's message inside a trigger-key transaction), sets
  `depositId = uint256(keccak256(abi.encode(forwarder, ++sendsOf[forwarder])))` (reorg-stable), stores
  `keccak256(abi.encode(account, token, amount))`, calls `Gateway.v2_sendMessage` with
  `xcm = xcmHead ‖ abi.encode(depositId, account, token, amount) ‖ xcmTail` and
  `claimer = claimerHead ‖ account`, then emits
  `Sent(uint256 indexed depositId, bytes32 indexed account, address token, uint256 amount)`.
  The router treats the three byte strings as opaque; `assethub/` produces them.

Asset Hub (`assethub/`), pool contract, Solidity:

- `constructor(address settler, uint16 frontFeeCapBps, uint256 bridgeFee, address feeRecipient...)`
  as the worker sees fit; `SETTLER` is the H160 of the router's Asset Hub account.
- `settle(uint256 depositId, bytes32 account, address token, uint256 amount)`, only `SETTLER`.
- `front(uint256 depositId, bytes32 account, address token, uint256 amount, uint256 fee)`, any payer.
- `addFunds(address token, uint256 amount)`, `removeFunds(address token, uint256 amount)`.
- Fronts are keyed by `keccak256(abi.encode(depositId, account, token, amount))`, settlement by
  `depositId`, so a mismatched front blocks nothing. View `state(depositId, account, token, amount)
  returns (uint8 none0/fronted1/settled2, address payer)` for the payout service.
- Events at least `Fronted(depositId, payer, account, token, amount, fee)` and
  `Settled(depositId, bool repaid, address to, uint256 amount)`.
- Pays users with the XCM precompile `execute` running `TransferAsset` to `AccountId32(account)`,
  never the ERC-20 precompile `transfer` (unmapped-account trap, see design doc).

The router's XCM (from the design doc, after Bridge Hub's own instructions, origin = router):
`DepositAsset(all, pool contract account)`, `Transact(SovereignAccount, Revive.call(pool,
settle(...)))`, `ExpectTransactStatus(Success)` (a failing settle makes the program `Incomplete`, so a
dry-run-gated relayer holds the message on Ethereum), `RefundSurplus`, `DepositAsset(all, fee account)`. The router sends `value = 0`, so
holding contains only the bridged token at the first `DepositAsset`.

## Milestones

| # | Work | Who | Done when |
|---|---|---|---|
| M1a | `eth/` contracts + Foundry tests (mock Gateway) | worker A | `forge test` green; review passed |
| M1b | Asset Hub facts on the local runtime, pool contract, template builder, deploy + dry-run tooling | worker B | facts in `assethub/FACTS.md`; pool deployed on local AH; a dry-run of the full delivered program from Bridge Hub's origin calls `settle` successfully; review passed |
| M1c | Relayer `isOurs` patch in `ethereum-v3` + Go unit tests | worker C | `go test` green for the patch, incl. a rotation in a backlog; review passed |
| M2 | Deploy all on the local stack, trigger + payout services (trigger service triggers only allowlisted, hook-free tokens) | worker | one deposit fronted on AH in under a minute and settled after finality, with the stock relayer |
| M3 | Swap in the patched relayer; scenarios | worker | fronted, unfronted, mismatched front, stranger zero-fee message ignored, trigger-key rotation in flight |

## Status

- M1a accepted (82 tests incl. 4 against the real local Gateway). Notes for later milestones: one
  trigger per transaction (the router refuses a second `send`); deposit ids come from `Sent` or the
  formula above; Foundry tests against the router need `isolate = true`.
- M1c accepted (66 Go tests). Binary `$SNOWBRIDGE_DIR/relayer/build/snowbridge-relay`;
  config example `web/packages/test/config/ethereum-v3-gc.json` in the patched Snowbridge (`getcash` block:
  `enabled`, `routers`, `registry`, `registry-deploy-block` = exact block of the Registry's
  constructor `RelayerChanged`, `registry-log-chunk`; own `deadNoncesPath`). The Asset Hub dry-run
  alert only exists with `gasEstimation.enabled`, which is off locally.
- M1b proven live (real Gateway message delivered by the stock relayer ran `settle`, user paid).
  Facts in `assethub/FACTS.md`. For later milestones: bridged token = TEST
  `0x54d6643762e46036b3448659791adaf554225541` (AH foreign asset index 1, not sufficient);
  `claimerHead` carries network `ByGenesis(westend)` (37 bytes), else a trap is not claimable;
  AutoMap is on, so no `map_account` setup message; the router's AH account needs WND for storage
  deposits (132_000_000 planck per new slot); the pool address is baked into `xcmHead`, so deploy
  order is: predict router (CREATE of the factory, nonce 1) → deploy pool with that settler →
  `pnpm template` → deploy factory → check `factory.ROUTER()` equals the prediction. A failing
  `Transact` does not fail the XCM, so delivery checks look for the pool's `Settled` event.
  A payout that fails inside `settle` is recorded as `owed[account][token]`; anyone can `claim` it
  to that same account later.
- M2a accepted (22 tests): trigger service + phone stand-in in `services/`. Registration is
  `POST /deposits {account, owner, address}`, checked against `factory.predict`; key reload on SIGHUP.
- M2 accepted (58 service tests). Live with the stock relayer: fronted user paid 6.1 s after the
  transfer, `Settled{repaid:true}` about 87 s after; capped deposit settled unfronted; unfunded user
  settled as `Owed` and `claim` paid it. `e2e/` deploys everything from scratch
  (`pnpm --dir e2e run deploy`, then `run e2e`). Asset Hub prunes state about 200 blocks back, and
  followers read finalized blocks only.
- Services review fixes accepted (152 tests).
- M3 done: all six scenarios pass with the patched relayer as the only Ethereum→Polkadot relayer
  (`e2e/RESULTS.md`). Findings for the design doc: `FINDINGS.md`. The patched relayer stays installed;
  revert with `setup.sh --revert-relayer`.

## Rules for every agent

- Never stop, restart or reconfigure the running stack unless your brief says so. Read it, send
  transactions to it, dry-run against it.
- Never build polkadot-sdk outside `setup.sh`, which throttles it (`-j 2`, `CARGO_BUILD_JOBS=1`) under the
  watchdog. Any other build or test that may use more than ~2 GB of RAM (Go builds, big node installs) runs
  under it too: `stack/memcap.sh 6 <log> -- <command>`.
- Go and the relayer build only exist in the patched Snowbridge checkout's Nix devShell:
  `SNOWBRIDGE_DIR=<checkout> stack/relayer-go.sh <cmd>` (it enters the shell from the checkout root; the shell
  hook keys caches off `$PWD`).
- Stay inside your path in the layout table. No commits, no pushes, no `gh` writes.
- Only local dev keys. Never print a private key in logs or output.
- Code style: small files, names carry meaning, comments only for a non-obvious why, one line.
  No narration, no TODOs, no AI attribution anywhere.
- Prefer a real check against the local stack over an assumption. When a fact from the design doc is
  wrong on this runtime, record it in your milestone's notes and adapt; do not silently diverge.
- If writing a report file is refused, return the content as text instead.
