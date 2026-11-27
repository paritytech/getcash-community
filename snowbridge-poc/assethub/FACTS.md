# Asset Hub facts for the pool contract

Runtime: `asset-hub-westend` fast-runtime, `spec_name westmint`, `spec_version 1025002`, built from polkadot-sdk `polkadot-stable2609-2` (`$POLKADOT_SDK_DIR`, with the Fulu patch). "Source" means that tree; "live" means the local Asset Hub at `ws://127.0.0.1:12144`. `pnpm facts` re-runs the live negative checks, `pnpm test:ts` the cross-checks against runtime APIs (the converter mirror is also tested offline against a metadata fixture), `pnpm dryrun --drain-router` the failing settle, `pnpm frontflow` the on-chain front path, `pnpm send` a real delivery through the Gateway, `pnpm claim` a claim of owed tokens.

## Pallets, calls, accounts

| Fact | Value | How verified |
|---|---|---|
| Pallet indices | Revive 60, PolkadotXcm 31, ForeignAssets 53, Balances 10, Assets 50, AssetConversion 56, XcmpQueue 30 | `construct_runtime!` in `asset-hub-westend/src/lib.rs`; live metadata |
| `Revive.call` | call index `[60, 1]`; args `(dest: H160, value: Compact<u128>, weight_limit: Weight, storage_deposit_limit: Compact<u128>, data: Bytes)` | `revive/src/lib.rs` `call`; live metadata; the template bytes decode in the dry run |
| `Revive.map_account` | call index `[60, 7]`, no arguments, **a no-op returning Ok**: `AutoMap = ConstBool<true>` | source `map_account`; live const `revive.autoMap = true`. The router account was unmapped before it was funded and mapped right after the first transfer (`OriginalAccount` entry appears) |
| Auto mapping | every new non-eth-derived account is mapped without deposit by `OnNewAccount = AutoMapper`; `unmap_account` fails with `AutoMappingEnabled`. A setup message with `map_account` is **not needed** here; it is only needed on a runtime without `AutoMap` (Polkadot Asset Hub may differ) | source `address.rs`, `lib.rs`; live |
| `Revive.instantiate_with_code` | `(value, weight_limit, storage_deposit_limit, code, data, salt: Option<[u8;32]>)`. For EVM bytecode `code` is the init code **with the constructor arguments appended** and `data` must be empty (`EvmConstructorNonEmptyData`). EVM bytecode compiled with `--evm-version cancun` is accepted | source `exec.rs` (`Code::Upload`); live deployment |
| Contract address to account | the contract's account is `H160 ++ 0xEE * 12` (fallback account); `reviveApi.accountId(pool)` returns it | source `AccountId32Mapper::to_fallback_account_id`; live (`test:ts`) |
| Account to address | an account ending in twelve `0xEE` maps to its first 20 bytes; every other account maps to `keccak256(account)[12..]` | source `AccountId32Mapper::to_address`; live `reviveApi.address` equals `reviveAddress()` |
| Address to account | `OriginalAccount[address]` if the account was mapped, otherwise the fallback `address ++ 0xEE * 12`. A payout to an address whose account never existed lands in a fallback account nobody controls | source `to_account_id` |
| Storage deposit | a new contract storage slot costs 132_000_000 planck, charged to the **signer of `Revive.call`** (for a delivered message: the router's Asset Hub account) from its free balance, because `PGasDeposit` falls back to native when it holds no PGAS | source `deposit_payment.rs`; dry run shows `balances.TransferAndHold StorageDepositReserve 132000000` from the router account |

## XCM precompile and the pool paying users

| Fact | Value | How verified |
|---|---|---|
| Address | `0x00000000000000000000000000000000000A0000` (`AddressMatcher::Fixed(10)`) | `pallet-xcm/precompiles/src/lib.rs`, `IXcm.sol` |
| Interface | `execute(bytes message, Weight weight)`, `send(bytes destination, bytes message)`, `weighMessage(bytes message) view returns (Weight)` with `Weight{uint64 refTime, uint64 proofSize}`; messages must be `VersionedXcm` V5 or newer; `execute` runs as `Signed(caller account)` and is blocked in static context | same files |
| Contract `execute`s `TransferAsset` from its own account (to-verify 5) | **yes**. The pool's account is the XCM origin (`AccountId32` with network `ByGenesis(westend)`), the foreign-assets transactor moves the token from it | live: dry run, and a real delivered message (below), show `foreignAssets.Transferred` from the pool's account to the user |
| `weighMessage` | callable from a contract as a view; `TransferAsset` weighs 252_670_000 ref time and 6_208 proof size, equal to what `polkadotXcm.Attempted` reports | live `reviveApi.call` and dry-run events |
| SCALE of `TransferAsset` | `05 04 04 04 02 02 09 07 <compact chain id> 03 00 <token20> 00 <compact amount> 00 01 01 00 <account32>`. `AccountKey20` is junction 3 | `XcmTransfer.sol` checked byte for byte against the runtime's own codec (`test/fixtures/xcm-transfer.json`, `forge test`) |

## ERC-20 precompile for foreign assets

| Fact | Value | How verified |
|---|---|---|
| Exists | yes: `ERC20<ForeignIdConfig<0x0220, ForeignAssetsInstance>>` | `asset-hub-westend/src/lib.rs` |
| Address | `<asset index, 4 bytes big endian> ++ 12 zero bytes ++ 0x02200000`. The index is `assetsPrecompiles.foreignAssetIdToAssetIndex(location)`, assigned in creation order | `assets/precompiles/src/lib.rs`, `foreign_assets.rs`; live |
| This POC's token | location `(2, [GlobalConsensus(Ethereum{11155111}), AccountKey20{None, 0x54d6643762e46036b3448659791adaf554225541}])` is index 1, precompile `0x0000000100000000000000000000000002200000` (Ether is index 0) | live storage |
| Works from a contract | `approve(pool, n)` by a payer, then the pool's `transferFrom(payer, pool, n)` in `addFunds`, and `transfer(payer, n)` in `removeFunds`. `balanceOf` and `totalSupply` answer; `decimals`/`symbol` **revert with "Metadata not found"**: Snowbridge's registration sets no metadata | live: `frontflow.ts` (real extrinsics), `facts.ts` |
| Payout to users | not through this precompile (unmapped-account trap above); the pool uses `TransferAsset` | design; source |

## Ethereum sender to Asset Hub account

| Fact | Value | How verified |
|---|---|---|
| Location | `(parents 2, [GlobalConsensus(Ethereum{chain_id 11155111}), AccountKey20{network None, key}])` after Bridge Hub's `UniversalOrigin(Ethereum)` and `DescendOrigin(AccountKey20)` | `converter.rs` |
| `LocationToAccountId` | tuple of `ParentIsPreset`, `SiblingParachainConvertsVia`, `AccountId32Aliases<RelayNetwork>`, `HashedDescription<DescribeFamily<DescribeAllTerminal>>` (does not match parents 2), `ExternalConsensusLocationsConverterFor<UniversalLocation>` which matches | `asset-hub-westend/src/xcm_config.rs`; `xcm-builder/src/location_conversion.rs` |
| Function | `blake2_256("ethereum-chain" ++ chain_id as u64 LE ++ key20)` | `ethereumSenderAccount()` in `src/location.ts`; equals `locationToAccountApi.convertLocation` for three senders (`test:ts`) |
| Its H160 | `keccak256(account)[12..]`; for the test router `0x7e57…0001` the account is `0x6eeda751…fe71`, the address `0x3080bb50562b07007F6b6cC587Aa0C720567E3Bc`. This is `msg.sender` in `settle` | `reviveApi.address` equals `reviveAddress()` |

## Transact and aliasing

| Fact | Value | How verified |
|---|---|---|
| `Transact(SovereignAccount)` runs `Revive.call` from that origin (to-verify 2) | yes: `SovereignSignedViaLocation<LocationToAccountId>` gives `Signed(account)`; `SafeCallFilter = Everything` | source; live dry run and a real delivery: pool `Settled` |
| `map_account` before the first `settle` (to-verify 3) | not needed, see Auto mapping. A `Transact(Revive.map_account)` ahead of the program is accepted and does nothing; `dryrun.ts --map-account` adds it (off by default, so the dry run is the program that is delivered) | live |
| A failed `Transact` does **not** abort the program | the executor records a transact status and goes on. Without a guard, a `settle` that reverts (a weight limit too small, a router account without WND for the storage deposit, a wrong settler) ends in `Complete` with the tokens already deposited into the pool and untracked. The template therefore puts `ExpectTransactStatus(Success)` right after the `Transact`: a failed `settle` makes the outcome `Incomplete{ExpectationFalse}`, so a dry-run-gated relayer holds the message and the tokens stay locked on Ethereum. A message delivered anyway (a public relayer) stops there: the tokens are in the pool, the leftover execution fee is trapped under the claimer | live: `facts.ts` section 2 (too small a weight limit, with and without the guard) and `dryrun.ts --drain-router` |
| Draining the router account | `dryrun.ts --drain-router` runs `Transact(Balances.transfer_all(//Alice, keep_alive))` as the router before the router's program, so `settle` cannot pay its storage deposit: outcome `Incomplete{ExpectationFalse}` at the guard, no `Settled` | live |
| `settle` does not revert on a failed payout | a failed payout to the user (or to the fee account) is recorded as `owed[account][token]` and emitted as `Owed`; the deposit is `Settled`. `claim(account, token)` retries it to the same account | `Pool.sol`; live dry run, a real delivery and a real `claim` (below) |
| The bridge fee applies to the bridged token only | `settle` takes no bridge fee for any other token, since the fee is in the bridged token's units | `Pool.sol`; `forge test` |
| A front is keyed by its parameters | `fronted[keccak256(abi.encode(depositId, account, token, amount))]` holds the payer and `settled[depositId]` the settlement, so a stranger fronting other parameters for a predictable `depositId` cannot block the honest front. `front` needs the id not settled and its own key not fronted; `settle` repays the payer of the matching key, else pays the user. View `state(depositId, account, token, amount) -> (0 none / 1 fronted / 2 settled, payer)` | `Pool.sol`; `forge test`; live `frontflow.ts` |
| Aliasing (to-verify 4) | `Aliasers = (AliasChildLocation, AuthorizedAliasers)`. Another Ethereum sender is not a prefix of the router's location, and the router never authorises anyone. Live: `AliasOrigin(router)` as another sender gives `Incomplete{NoPermission}` at the `AliasOrigin`; aliasing into its own child works; `isAuthorizedAlias(router <- other)` is false. Only the bare Ethereum location (programs with the Gateway itself as origin: the fixed token-registration program) could alias into a router | live `facts.ts` section 1 |

## How Bridge Hub builds the program

Source: `bridges/snowbridge/primitives/inbound-queue/src/v2/{message,converter,processor}.rs`, Bridge Hub `bridge_to_ethereum_config.rs`. Mirrored by `src/delivered.ts` and checked by a real delivery.

- Gateway `v2_sendMessage(xcm, assets, claimer, executionFee, relayerFee)` takes `msg.sender` as the message origin. `xcm` is the SCALE `VersionedXcm` **without any kind byte** (the Gateway wraps it as `Xcm{kind: 0, data}`); the first byte is the version, `0x05` for V5.
- Bridge Hub decodes it with `VersionedXcm::decode_all_with_mem_and_depth_limit` and converts to V5. **Any failure silently becomes an empty program**, so a bad splice traps the funds under the claimer. The dry run is the only check; `deliveredProgram()` throws on trailing or missing bytes.
- `claimer` is decoded with `Location::decode`; on failure it falls back to the Snowbridge sovereign account.
- Delivered program: `DescendOrigin(PalletInstance(91))`, `UniversalOrigin(GlobalConsensus(Ethereum))`, `ReserveAssetDeposited(execution fee in ether)`, `SetHints(AssetClaimer)`, `PayFees(execution fee)`, `ReserveAssetDeposited(token)` (plus ether if `value > 0`), `DescendOrigin(AccountKey20{sender})`, the user's instructions, `SetTopic` (added unless the user's program ends with one). Execution is paid up front; the user program must not buy execution. No other prefix is added by the processor.
- The program's weight includes the `Revive.call`'s `weight_limit` plus its base weight, so `weight_limit` sets the execution fee that must be supplied. The unused part is returned by `RefundSurplus`.

## Claimer encoding

A trapped asset is filed under the claimer location **exactly** (network included). A signed claim (`polkadotXcm.claim_assets`) runs with `AccountId32{network: Some(ByGenesis(westend 0xe143f238…423e)), id}`: live, a signed `execute` that traps assets reports exactly that origin in `AssetsTrapped`. A claimer with `network None` (`claimerHead = 0x00010100`) is therefore not claimable by the user. `src/template.ts` derives the network from the connected chain (`src/network.ts`): it asks the runtime, with `ExpectOrigin` in a dry-run `polkadotXcm.execute` as a signed account, which of the known networks (Polkadot, Kusama, Westend, Paseo, Rococo) its signed origin carries, and throws when none matches. Here that is `ByGenesis(westend)`, so `claimerHead = 0x0001010100e143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e` (parents 0, X1, AccountId32, `Some(ByGenesis(westend))`); on Polkadot Asset Hub it is `Polkadot`. `claimer = claimerHead ++ account` (69 bytes). A mapping from the connected chain's genesis hash cannot work: the runtime names itself with Westend's real genesis `0xe143f238…` while the local Asset Hub's genesis is `0xa9c31e14…` and the local relay's `0x8d8bfd65…`, and on any network a parachain's genesis is not the relay's.

## Router template

`xcmHead ++ abi.encode(depositId, account, token, amount) ++ xcmTail` equals the program encoded with the real calldata (`test:ts`). For the default limits and fee account: `xcmHead` is 90 bytes and ends with `0x1102` (compact 132) and the `settle` selector `0x2a268daf`; `xcmTail` is 42 bytes: `ExpectTransactStatus(Success)` (`2000`), `RefundSurplus` (`14`), `DepositAsset(Wild(All) -> fee account)`. The head starts `05 14 0d 01 00 …`: V5, five instructions, `DepositAsset(Wild(All))` to the pool's fallback account. The `Transact` has `fallback_max_weight None` (the executor weighs the decoded call).

## Measured on the local runtime

Default limits `weight_limit = 2.5e9 ref time / 150_000 proof size`, `storage_deposit_limit = 1e10`. All figures are for the program Bridge Hub delivers (no `map_account` prefix, with the `ExpectTransactStatus` guard); a real delivery used exactly what the dry run predicted:

| Item | Value |
|---|---|
| Whole delivered program | 38_787_116_000 ref time, 901_513 proof size (`xcmPaymentApi.queryXcmWeight`) |
| Execution fee quoted | 276_212_852_237 wei of ether (`queryWeightToAssetFee`); the dry run provides 1.2 times that |
| Executed (`Complete`) | 37_356_785_320 / 803_444 when the user is paid, in the dry run and in the real delivery (message queue `weightUsed`); 37_592_228_644 / 823_968 when the user's payout fails and is owed (dry run) |
| `settle` itself (limit minus the refunded surplus) | about 1.07e9 ref time / 51_931 proof size when it pays the user and the fee account; 1.31e9 / 72_455 when the user is owed; **worst path 1.50e9 / 83_133 with both the user and the fee account owed** (`reviveApi.call` with no tokens in the pool: `dryrun.ts --worst-path`), so the 2.5e9 / 150k limits leave about 1.7x and 1.8x |
| Execution fee actually spent | about 246e9 wei (paid) to 253e9 wei (owed) after the refund to the fee account |
| Storage deposit | 132_000_000 planck per new storage slot, from the router's free balance: 132_000_000 for a paid `settle` (`settled[depositId]`), 396_000_000 when the user is owed (plus `owed`, `totalOwed`), 528_000_000 on the worst path (plus the fee account's `owed`) |
| Funding | the router's Asset Hub account needs native balance for those deposits (5 WND funded) |

These are local fast-runtime weights and the local ether/WND pool rate; re-measure on the target runtime.

## Foreign assets

| Asset | State |
|---|---|
| Ether `(2, [GlobalConsensus(Ethereum 11155111)])` | index 0, sufficient, min balance 1, 18 decimals |
| Rococo native `(2, [GlobalConsensus(ByGenesis rococo)])` | not an ERC-20, no precompile index |
| TEST `0x54d6…5541` | **was not registered**; registered with `Gateway.v2_registerToken(token, 0, 1.5e12, 1.5e12)` and value `13e12` from the deployer key (Ethereum tx `0x17d7f5dde4a71d8a7913bdce8c2e7e0a48cca75dbaea58d7bc1bf44ad4511be0`, block 15772), created on Asset Hub by the stock relayer about two minutes later. Index 1, owner/admin the Snowbridge sovereign, **not sufficient**, min balance 1, no metadata |

Consequences of "not sufficient": an account can hold the token only if it exists natively. Live: `DepositAsset` of the token to a never-funded account fails with `FailedToTransactAsset`; the pool's own account holds native ED from creation (`init_contract`). A user without native balance cannot be paid. The pool then records the amount as owed to that account (`Owed` event, `owed(account, token)`), keeps the tokens, and anyone can call `claim(account, token)` once the account exists; the payout always goes to that same account. Live: dry run and a real delivery give `Settled` + `Owed`; a `claim` before the account exists reverts (the precompile's revert bubbles up); after //Alice sent the account 0.01 WND, //Alice's `claim` paid the account in full and `owed` went to 0.

TEST is minted on Ethereum only by `Token.gateway()`, which for this stack is the deployer account, so the deployer can mint test balances (`src/send.ts` does).

## Live runs recorded

| What | Result |
|---|---|
| Pool 1 `0x5801B439A678D9d3a68b8019dA6A4abFa507dE11` | settler = account of test router `0x7e57000000000000000000000000000000000001`; deployed in Asset Hub block `0xb23ba19c…b583` (extrinsic `0xbc30eba5…4de9`); used for the dry runs and the front path (deposit 77 stays fronted and unsettled) |
| Pool 3 `0x291F4f5471385ED0a30757A7e69FdF2720D9Effa` | owed/claim version (`settle` never reverts on a failed payout); superseded by pool 4; block `0x7bcad13c…10a2`, extrinsic `0x11f5466c…d792` |
| Pool 4 `0xB113eB99f18Da5f13A63b353d71B5b5050a3Ec54` (`deployments/local.json`) | current: bridge fee for the bridged token only, fronts keyed by their parameters, `state`, `settled`, `FeeCapTooHigh`, the template guarded by `ExpectTransactStatus`. Same constructor arguments and settler as pool 2; block `0xda823850…f9cc`, extrinsic `0x4b18093b…a12f` |
| Dry runs on pool 4 | normal (`pnpm dryrun`): `Complete`, `Settled` and `UserPaid`. Drained router (`pnpm dryrun --drain-router`): `Incomplete{index 10, ExpectationFalse}`, no `Settled`. Fresh user: `Complete`, `Settled`, `Owed` |
| Pool 2 `0xdd38d8F1EEcEc8F6513c58c6848C3ca6a54bBf33` | first version (a failed payout reverts `settle`); settler = account of the deployer key acting as a stand-in router, so a real delivery could be proven; block `0x52b760ae…8f48`, extrinsic `0x07f8527e…99e5`. Superseded |
| Router accounts funded from `//Alice` | 5 WND each, blocks `0xcb38538b…96dc` and `0x6cb1b04f…1968` |
| Real delivery of a deposit whose user has no account, pool 3 | `Gateway.v2_sendMessage` (Ethereum tx `0x6dad68dc21ff1a69ecf27862349578af1ae25f2faf529928eff07dc7b51192fe`, block 17731) with 3 TEST for //Owed1 (never funded); delivered about 135 s later in Asset Hub block 7948 `0x0b1e949d…2450`, message queue success, `Settled{depositId 101}` and `Owed{2.999e18}`; the fee account was still paid |
| `claim` on pool 3 | before funding, `claim` reverts; //Alice funded //Owed1 with 0.01 WND (block `0x86097ae3…7d5d`, extrinsic `0x58d9069e…0600`) and called `claim` (block `0x99c586ce…39ca`, extrinsic `0x988159f1407a0b40af103bc537657943872f7258ae53b1d0927fd9a7a76af977`): //Owed1's token balance 0 to 2.999e18, `owed` 0 |
| Real delivery to pool 2 (before the change) | `Gateway.v2_sendMessage` (Ethereum tx `0x29f2a7a21e0716118c84b2baee61066849be56a90ab3d5e4c6e32afba10e7ff1`, block 17140) with the router template and 5 TEST; delivered by the stock relayer about 115 s later in Asset Hub block 7672 `0x678c53bd…0e6c`, `messageQueue.Processed` success, weight 37_409_457_804 / 809_176, `Settled{repaid:false, amount 4.999e18}`, user //Bob paid 4.999e18 |
| TEST on Asset Hub | 1000 TEST bridged to //Alice with a plain `DepositAsset` message (Ethereum tx `0xc79eb383e9ceb0e9232d0b2a6e09ace80643fe17bc1214a0b8d19ddea44320ad`) |
| Front path on pool 1, real extrinsics | extrinsics `approve` `0x8db8012284f1a6fbf51f0ac6fbd96eee8f6f5687929c65d0fc4672368e8ef36b`, `addFunds` `0xacab7477324b08fb2fe6ace029bc1f049673082a8e7b927135609bfbbbdc8dda`, `front` `0xf399ae9c1b01733b932131896e47642a17941759678ce1b168bc657b0c89b452`, `removeFunds` `0x43e409e7141527bd1d7c38c21bab978381e5d0f3b447a2292a2bb189099d70d1`; user received 99.899 TEST of a 100 TEST deposit (fee 0.101 = bridge fee 0.001 + 0.1%). Dry-run `settle` as the router: matching parameters give `Settled{repaid:true, to payer, amount 99.999}`, a different amount gives `repaid:false` and the user is paid in full |
| Real delivery to pool 4 (guarded template) | Ethereum tx `0x840f25b9ad9e910e65369f3f0d25ba3fa6ba72c028c94a7345d561a77af3e20d`, block 19369, 2 TEST for //Bob; delivered about 115 s later in Asset Hub block 8680 `0x98ce33b7…8696`, message queue success, weight 37_356_785_320 / 803_444 (the dry run predicted the same), `Settled{depositId 200}` and `UserPaid`, //Bob +1.999 TEST |
| Front path on pool 4, real extrinsics | `approve` `0xdbf658abd83cf0b6e8e0e8dd53f75f1f37d1b7c3ec16c2d00b81cd138fe7a175`, `addFunds` `0x17eaa45ac9a2bf2f25c20573638a5c5e3f5bc7011aff0c5059d16c41d657d7bb`, `front` `0x349cbabe1b3cd6a225575c5a2668b44ca345670ca2c14680693f9a92506cad9b`, `removeFunds` `0xbe8ac63d5232b2338c3a348dfa666f6db69efb40f08c206d272c8e988c1d68e9`; `state(77, //Bob, TEST, 100 TEST)` read `1` with the payer; the dry-run `settle` repaid the payer, and one with another amount paid the user in full |
