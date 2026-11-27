# M3 results: the patched relayer on the local stack

Run `mwyub0n2`, 2026-11-27T10:29:57.374Z. Overall: **all scenarios pass**.

Deployment: Registry `0xb636785adA72801F869BcFE5884f7A1EeE69227A` (deploy block 401), Router `0x7BA5056287A9658236726EfB6c37EA2a24181daE`, Factory `0xe93F13b38f138f8F96ED82816Fd2af0E248A4CAC`, Pool `0x124954f324aB6253B8EFc74C3073a7e88338CdA5`, Gateway `0xb1185ede04202fe62d38f5db72f71e38ff3e8305`.

Our patched relayer was the only Ethereum to Polkadot relayer, and every Gateway message of the run had relayer fee 0.

## How to reproduce

```
snowbridge-poc/setup.sh                # sources, builds, stack, TEST token, deploy, relayer swap, then S1-S6 (writes this file)
snowbridge-poc/setup.sh --scenarios    # S1-S6 again on the running stack
```

Step by step, from `snowbridge-poc` with the environment `setup.sh` exports (`OUTPUT_DIR`, `SNOWBRIDGE_DIR`):

```
pnpm --dir e2e install
pnpm --dir e2e exec tsx src/registerToken.ts   # only after a stack restart: registers TEST on the Gateway, waits for Asset Hub
pnpm --dir e2e run deploy                      # keys, pool, registry, factory, router, payer funds (needs the stock relayer for the TEST bridge)
pnpm --dir e2e run e2e                         # baseline scenarios B1-B5 against whichever relayer runs
pnpm --dir e2e run relayer swap                # patched relayer in, stack's loop restarts ethereum-v3
pnpm --dir e2e run scenarios                   # S1-S6, writes this file
```

## Relayer swap

- backed up /tmp/snowbridge-v2/ethereum-v3.json as /tmp/snowbridge-v2/ethereum-v3.json.stock
- backed up /tmp/snowbridge-v2/bin/snowbridge-relay as /tmp/snowbridge-v2/bin/snowbridge-relay.stock
- the stack's binary is already identical, left in place
- wrote the getcash config (registry 0xb636785adA72801F869BcFE5884f7A1EeE69227A, router 0x7BA5056287A9658236726EfB6c37EA2a24181daE, deploy block 401)
- ethereum-v3 restarted by the stack's loop in 21.0 s (pid 43993 -> 47261)
- getcash filter started: 2026-11-27T11:29:52.94212+01:00 [getcash] ours-only mode: delivering only router messages signed by the trigger key
- 0 error lines in the log since the restart
- beacon light client advanced from slot 416 to 448
- at the start of the run: ethereum-v3 relayer pid 47261, getcash block {"enabled":true,"registry":"0xb636785adA72801F869BcFE5884f7A1EeE69227A","routers":["0x7BA5056287A9658236726EfB6c37EA2a24181daE"],"registry-deploy-block":401,"registry-log-chunk":10000}
- pool immutables match the deployment: SETTLER 0x2F71a8e16349b7705E8aF2E2E40c582Df3bc353d, TOKEN 0x54D6643762E46036b3448659791adAf554225541, TOKEN_ERC20 0x0000000100000000000000000000000002200000, FEE_ACCOUNT 0xf2172ff060f80e7999e759d04db38b49b701cc2c0318f075afb5338d3eceb969, BRIDGE_FEE 1000000000000000, FRONT_FEE_CAP_BPS 100, ETHEREUM_CHAIN_ID 11155111

## Scenarios

| id | scenario | result | checks |
|---|---|---|---|
| S1 | fronted | pass | 16/16 |
| S2 | not fronted | pass | 8/8 |
| S3 | mismatched front | pass | 24/24 |
| S4 | strangers are ignored | pass | 13/13 |
| S5 | trigger-key rotation in flight | pass | 22/22 |
| S6 | restart catches up | pass | 20/20 |

### S1 fronted: pass

Timings (seconds)

| what | seconds |
|---|---|
| fronted: trigger sent | 3.2 |
| fronted: user paid | 6.1 |
| fronted: fronted | 6 |
| fronted: settled | 92.9 |

References

| what | value |
|---|---|
| fronted: trigger tx | `0x215664633141168088cc21b1df33a41f08b56fdb366ce2cab66a92b5de9fa26d` |
| fronted: trigger Ethereum block | `605` |
| fronted: Gateway nonce | `3` |
| fronted: front extrinsic | `0x3a8ec8fa847e1142db6ed5b528791a0a38ef467484c5823b39b999440f84ee77` |
| fronted: front block hash | `0xd0e8450c2e94a5e60cdc12928318896f854fc14b52f48d7613e50cd9643fc80a` |
| fronted: Fronted Asset Hub block | `182` |
| fronted: Settled Asset Hub block | `226` |
| fronted: Settled block hash | `0x5a320419554c3f47fbcf86c1e604b935be0c90156878c507df4b5b8bbde28d6a` |
| fronted: relayer log, batched | `2026-11-27T11:32:17.606542+01:00 [instant-eth] catch-up: Including EthereumInboundQueueV2.submit (nonce 3)` |

Checks

- ok: the trigger service runs with the registry's relayer key (running, key 0x5144B40D5460E6B03b06f79b6e61ad3B02316c29)
- ok: fronted: the trigger service recorded the expected deposit id (70748472015693559653109534584428079394328843139376923966373786264152944722849)
- ok: fronted: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: fronted: the user was paid within 60 s of the transfer (6.1 s)
- ok: fronted: the user holds amount minus fee on Asset Hub (99.899 TEST, expected 99.899)
- ok: fronted: the fee is the bridge fee plus 10 bps (0.101 TEST)
- ok: fronted: Fronted names the payer, the user, the amount and the fee (Asset Hub block 182)
- ok: fronted: the payer's pool funds fell by the payout
- ok: fronted: the payout service counts the payout as outstanding (99899000000000000000)
- ok: fronted: Settled{repaid:true} to the payer for amount minus bridge fee (Asset Hub block 226)
- ok: fronted: the user was not paid a second time
- ok: fronted: nothing is owed to the user
- ok: fronted: the payout service marked the deposit repaid
- ok: fronted: the relayer log shows nonce 3 batched for delivery (2026-11-27T11:32:17.606542+01:00, [instant-eth] catch-up: Including EthereumInboundQueueV2.submit)
- ok: fronted: the relayer never screened nonce 3 out
- ok: fronted: Bridge Hub's nonce bitmap has nonce 3 set

### S2 not fronted: pass

Timings (seconds)

| what | seconds |
|---|---|
| not-fronted: trigger sent | 4.2 |
| not-fronted: settled | 110.9 |
| not-fronted: user paid | 110.9 |

References

| what | value |
|---|---|
| not-fronted: trigger tx | `0x9cfe69e095bfaa83b0290407746cc0f02f466a19d24057609e282477cb0a6a2a` |
| not-fronted: trigger Ethereum block | `660` |
| not-fronted: Gateway nonce | `6` |
| not-fronted: Settled Asset Hub block | `262` |
| not-fronted: Settled block hash | `0x4945e703c23cc7791aaccb94344c8fdc759832abc3d76b871e14ca8c221b57e9` |
| not-fronted: relayer log, batched | `2026-11-27T11:33:29.773259+01:00 [instant-eth] catch-up: Including EthereumInboundQueueV2.submit (nonce 6)` |

Checks

- ok: not-fronted: the trigger service recorded the expected deposit id (41585395564266026030515038366906610545568969700753747096253359961232398421978)
- ok: not-fronted: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: not-fronted: the payout service left it unfronted (skipped: payout 299699000000000000000 exceeds the per-deposit cap 150000000000000000000)
- ok: not-fronted: Settled{repaid:false} for amount minus bridge fee (Asset Hub block 262)
- ok: not-fronted: the user is paid amount minus bridge fee on delivery (299.999)
- ok: not-fronted: the relayer log shows nonce 6 batched for delivery (2026-11-27T11:33:29.773259+01:00, [instant-eth] catch-up: Including EthereumInboundQueueV2.submit)
- ok: not-fronted: the relayer never screened nonce 6 out
- ok: not-fronted: Bridge Hub's nonce bitmap has nonce 6 set

### S3 mismatched front: pass

Timings (seconds)

| what | seconds |
|---|---|
| mismatch-excluded: trigger sent | 3.3 |
| mismatch-honest: trigger sent | 4.1 |
| mismatch-excluded: settled | 126.9 |
| mismatch-honest: settled | 128.9 |

References

| what | value |
|---|---|
| second payer | `5GgMoFqLnEYVR8XTeC6YVJrHG2PpvC7Lpagyz61kUyns8M9q` |
| mismatch-excluded: trigger tx | `0x197906d8647de05d8b94c9638dcdaac2fffd3c82814e9c2953580534de819d31` |
| mismatch-excluded: trigger Ethereum block | `667` |
| mismatch-excluded: Gateway nonce | `7` |
| mismatch-honest: trigger tx | `0xafc4192ec63395cbfcbbf790163e6a5d35c49d324da8d3bc32094150128c5b00` |
| mismatch-honest: trigger Ethereum block | `690` |
| mismatch-honest: Gateway nonce | `8` |
| wrong amount front (excluded) | `0xc7b3197efa5e634c0a04770776cc2ea1357dadb63a07ec705b3c7c2531ed6903` |
| wrong account front (excluded) | `0x4c67907ec697529ea88ad9eece581cc656863c1991514a677ba783a7ea9022e7` |
| wrong amount front (honest) | `0xa32554ad5be1912fc6b4c063cfdfd62a5a605c32863f86105a8102386ea162bd` |
| mismatch-excluded: Settled Asset Hub block | `265` |
| mismatch-excluded: Settled block hash | `0x8448a3570e49ad091f6e4256065eae906cf0f0bd5e14790e739884299dc2a70d` |
| mismatch-honest: Settled Asset Hub block | `277` |
| mismatch-honest: Settled block hash | `0x23eebcce7b471e663b7719d767b031dd4df9bd48b9605ce8e0d9e9f93a6f26e9` |
| mismatch-excluded: relayer log, batched | `2026-11-27T11:33:29.773267+01:00 [instant-eth] catch-up: Including EthereumInboundQueueV2.submit (nonce 7)` |
| mismatch-honest: relayer log, batched | `2026-11-27T11:34:06.825626+01:00 [instant-eth] catch-up: Including EthereumInboundQueueV2.submit (nonce 8)` |

Checks

- ok: the second payer holds its own funds in the pool (300 TEST, payer 5GgMoFqLnEYVR8XTeC6YVJrHG2PpvC7Lpagyz61kUyns8M9q)
- ok: mismatch-excluded: the trigger service recorded the expected deposit id (43732863625857021080092790167420424058539037342557920395035136895905396577591)
- ok: mismatch-excluded: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: mismatch-honest: the trigger service recorded the expected deposit id (102135460951558255577946093488218112819811386768951742495572245629302145950694)
- ok: mismatch-honest: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: the payout service left the excluded deposit unfronted (skipped: payout 199799000000000000000 exceeds the per-deposit cap 150000000000000000000)
- ok: the payout service fronted the honest deposit with the right parameters (front 0x062b9ca148c7aaf7f3b9896f6ecd3da99ea860bb5074022f7f51dd14623199bc)
- ok: before settlement the wrong fronts paid the user the wrong amount and the bystander the real amount (49.999 and 199.999 TEST)
- ok: the honest deposit's user holds the honest payout plus the wrong front's payout (109.918 TEST)
- ok: nobody fronted the real parameters of the excluded deposit (state 0, payer 0x0000000000000000000000000000000000000000)
- ok: the pool keeps the wrong front under its own key, with the second payer (state 1, payer 0x58d17e6b553dc59a9163ba7d4329fe4279910362)
- ok: excluded: Settled{repaid:false} pays the user amount minus bridge fee, the wrong fronts changed nothing (Asset Hub block 265)
- ok: excluded: the user holds the wrong front's payout plus the full settlement (249.998 TEST)
- ok: excluded: the bystander was not paid again
- ok: honest: Settled{repaid:true} repays the honest payer only (Asset Hub block 277)
- ok: honest: the user was not paid a second time
- ok: the second payer was not repaid for either wrong front (20.003 TEST of 300)
- ok: each wrong front is on chain as a Fronted event of the second payer
- ok: mismatch-excluded: the relayer log shows nonce 7 batched for delivery (2026-11-27T11:33:29.773267+01:00, [instant-eth] catch-up: Including EthereumInboundQueueV2.submit)
- ok: mismatch-excluded: the relayer never screened nonce 7 out
- ok: mismatch-excluded: Bridge Hub's nonce bitmap has nonce 7 set
- ok: mismatch-honest: the relayer log shows nonce 8 batched for delivery (2026-11-27T11:34:06.825626+01:00, [instant-eth] catch-up: Including EthereumInboundQueueV2.submit)
- ok: mismatch-honest: the relayer never screened nonce 8 out
- ok: mismatch-honest: Bridge Hub's nonce bitmap has nonce 8 set

### S4 strangers are ignored: pass

Timings (seconds)

| what | seconds |
|---|---|
| observation window | 360 |

References

| what | value |
|---|---|
| 4a Gateway tx | `0x33902286110d99606ff7978673a81a23618e18dbab21be1016fefe166e24eb22` |
| 4a Gateway nonce | `4` |
| 4a Ethereum block | `645` |
| 4b forwarder | `0x0EeD6FF7f4B5197ae129747EbFb22639A2BD6539` |
| 4b trigger tx | `0xc49e35563c8c4f02c6be407f5d1af223f8f5a25ec58c156fdc70db72b80fe346` |
| 4b Gateway nonce | `5` |
| 4b Ethereum block | `650` |
| 4b payout service | `skipped: not triggered by our key` |
| 4a: relayer log, screened | `2026-11-27T11:33:29.767028+01:00 [getcash] not ours; skipping (nonce 4)` |
| 4b: relayer log, screened | `2026-11-27T11:33:29.767507+01:00 [getcash] not ours; skipping (nonce 5)` |
| pending stranger nonces | `4, 5` |

Checks

- ok: 4a: the message's origin is the stranger's own account, not the router, and its relayer fee is 0 (origin 0xdfe9a3f274e95a38ea39a7902805440b467b4e3a)
- ok: 4b: the message's origin is the router and its relayer fee is 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae)
- ok: 4b: the transaction was signed by the stranger, not by the registry's trigger key (signer 0xf2ea0725d8433ac4d224cfb5b03f79c74fde3792, trigger key 0x5144B40D5460E6B03b06f79b6e61ad3B02316c29)
- ok: 4b: the payout service recorded the stranger-triggered deposit as skipped and did not front it (skipped: not triggered by our key)
- ok: 4a: the relayer log shows nonce 4 screened out as not ours (2026-11-27T11:33:29.767028+01:00)
- ok: 4a: the relayer never batched nonce 4
- ok: 4a: Bridge Hub's nonce bitmap does not have nonce 4 set
- ok: 4b: the relayer log shows nonce 5 screened out as not ours (2026-11-27T11:33:29.767507+01:00)
- ok: 4b: the relayer never batched nonce 5
- ok: 4b: Bridge Hub's nonce bitmap does not have nonce 5 set
- ok: 4a: nothing reached the stranger's account on Asset Hub
- ok: 4b: nothing reached the stranger's account on Asset Hub, nobody fronted it, and the pool never settled its deposit
- ok: the relayer was delivering in the same window: our messages with higher nonces were settled (not-fronted nonce 6, mismatch-excluded nonce 7, mismatch-honest nonce 8)

### S5 trigger-key rotation in flight: pass

Timings (seconds)

| what | seconds |
|---|---|
| rotation-in-flight: trigger sent | 4.4 |
| setRelayer after the K1 trigger | 1.7 |
| rotation-after: trigger sent | 24.2 |
| rotation-in-flight: settled | 144.9 |
| rotation-after: settled | 152.9 |

References

| what | value |
|---|---|
| trigger key K1 | `0x5144B40D5460E6B03b06f79b6e61ad3B02316c29` |
| trigger key K2 | `0x315c09F93f983949E05F79d76E8f510dB9FC6fa5` |
| rotation-in-flight: trigger tx | `0xaea6a4217f3426238fc5856194fdf9af9a58af64ba451f8f9452801aa14e4450` |
| rotation-in-flight: trigger Ethereum block | `866` |
| rotation-in-flight: Gateway nonce | `9` |
| setRelayer(K2) tx | `0xa8e42b0c5277c8ef73b4ac49e8c64a075575023101f9045159ce16d35fc96385` |
| setRelayer(K2) Ethereum block | `868` |
| K1 trigger after rotation (reverted) | `0xf9f3d55b4528f6ed8cb3959a826e0b5678215505feda69101bcd600be82da51c` |
| service resumed with K2 | `0x315c09F93f983949E05F79d76E8f510dB9FC6fa5` |
| rotation-after: trigger tx | `0xc02b70d5b92a5adf2877b0d199d051343f8b0897838dd960d4b968cd80b8761d` |
| rotation-after: trigger Ethereum block | `878` |
| rotation-after: Gateway nonce | `10` |
| rotation-in-flight: Settled Asset Hub block | `367` |
| rotation-in-flight: Settled block hash | `0xdfa5690f777029fca2ae449811ec013b2e0931e25127ecf7facfba37b7c643b0` |
| rotation-in-flight: relayer log, batched | `2026-11-27T11:37:21.176341+01:00 [instant-eth] Including EthereumInboundQueueV2.submit in force_batch (nonce 9)` |
| rotation-in-flight: relayer log, processed | `2026-11-27T11:37:53.588524+01:00 [instant-eth] Message successfully processed (nonce 9)` |
| rotation-after: Settled Asset Hub block | `370` |
| rotation-after: Settled block hash | `0x9a794cfb891a52fff12895cbc49b86cc6e74bda13701413eecfb9221355a629a` |
| rotation-after: relayer log, batched | `2026-11-27T11:37:21.176384+01:00 [instant-eth] Including EthereumInboundQueueV2.submit in force_batch (nonce 10)` |
| rotation-after: relayer log, processed | `2026-11-27T11:37:53.588623+01:00 [instant-eth] Message successfully processed (nonce 10)` |
| setRelayer(K1) restore tx | `0xfb483151e380c1b33da2e8c8554756f7e6c3c45197e291f89834e13ad79bf8fe` |

Checks

- ok: rotation-in-flight: the trigger service recorded the expected deposit id (106956747923235378928818836318183550370692973288314017303475932619356322703960)
- ok: rotation-in-flight: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: rotation-in-flight: the first deposit was triggered by K1 (0x5144b40d5460e6b03b06f79b6e61ad3b02316c29)
- ok: the admin rotated to K2 after K1's message was sent and before it was delivered (trigger block 866, setRelayer block 868)
- ok: a trigger by K1 after the rotation reverts NotRelayerOrOwner (NotRelayerOrOwner)
- ok: the same trigger, sent anyway, was mined and reverted (reverted)
- ok: the trigger service stopped on its own, because its key is no longer registry.relayer() (stopped, registry relayer 0x315c09F93f983949E05F79d76E8f510dB9FC6fa5)
- ok: while stopped the service triggered nothing: the registered deposit is still unsent
- ok: rotation-after: the trigger service recorded the expected deposit id (61619257482262371128787385523443488625728607075099712647856769016455189483641)
- ok: rotation-after: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: rotation-after: the deposit was triggered by K2 once the service reloaded its key on SIGHUP (0x315c09f93f983949e05f79d76e8f510db9fc6fa5)
- ok: rotation-in-flight: delivered by our relayer, Settled for amount minus bridge fee (Settled{repaid:true}, Asset Hub block 367)
- ok: rotation-in-flight: the user holds the payout (39.959 TEST)
- ok: rotation-in-flight: the relayer log shows nonce 9 batched for delivery (2026-11-27T11:37:21.176341+01:00, confirmed 2026-11-27T11:37:53.588524+01:00)
- ok: rotation-in-flight: the relayer never screened nonce 9 out
- ok: rotation-in-flight: Bridge Hub's nonce bitmap has nonce 9 set
- ok: rotation-after: delivered by our relayer, Settled for amount minus bridge fee (Settled{repaid:true}, Asset Hub block 370)
- ok: rotation-after: the user holds the payout (39.959 TEST)
- ok: rotation-after: the relayer log shows nonce 10 batched for delivery (2026-11-27T11:37:21.176384+01:00, confirmed 2026-11-27T11:37:53.588623+01:00)
- ok: rotation-after: the relayer never screened nonce 10 out
- ok: rotation-after: Bridge Hub's nonce bitmap has nonce 10 set
- ok: the relayer process and its config were untouched during the rotation: no restart, no config change (pid 47261)

### S6 restart catches up: pass

Timings (seconds)

| what | seconds |
|---|---|
| restart: trigger sent | 3.2 |
| relayer down until restarted | 20.2 |
| restart: settled | 98.9 |

References

| what | value |
|---|---|
| restart: trigger tx | `0x4ba02272d5e1a3af390b863412313c5e8a9d9a4b293bcdebff38fd24325f609e` |
| restart: trigger Ethereum block | `1055` |
| restart: Gateway nonce | `11` |
| relayer pid | `47261 -> 51622` |
| relayer restarted | `2026-11-27T11:38:45.512281+01:00 [getcash] ours-only mode: delivering only router messages signed by the trigger key` |
| restart: Settled Asset Hub block | `436` |
| restart: Settled block hash | `0x6b298251146a6ffa63798515eec6a367c8d128c9eb0251e57a8e8b4d3dc5dfe8` |
| restart: relayer log, batched | `2026-11-27T11:39:59.174124+01:00 [instant-eth] catch-up: Including EthereumInboundQueueV2.submit (nonce 11)` |
| 4a after restart: relayer log, screened | `2026-11-27T11:38:45.536259+01:00 [getcash] not ours; skipping (nonce 4)` |
| 4b after restart: relayer log, screened | `2026-11-27T11:38:45.537717+01:00 [getcash] not ours; skipping (nonce 5)` |

Checks

- ok: restart: the trigger service recorded the expected deposit id (1441839376178219931545318347307822203612797792441523398095673486998947115091)
- ok: restart: the Gateway message has the router as origin and relayer fee 0 (origin 0x7ba5056287a9658236726efb6c37ea2a24181dae, relayer fee 0)
- ok: restart: the deposit was triggered by K2, a key that is in the registry history but not the constructor's (0x315c09f93f983949e05f79d76e8f510db9fc6fa5)
- ok: restart: the message was still undelivered when the relayer was killed
- ok: the stack's loop started ethereum-v3 again with a new pid (20.2 s)
- ok: the restarted relayer loaded its own dead-nonce file (2026-11-27T11:38:45.377328+01:00 loaded dead-nonce store)
- ok: restart: the message was delivered after the restart, once (Settled{repaid:true}, Asset Hub block 436)
- ok: restart: the user holds the payout
- ok: restart: the relayer log shows nonce 11 batched for delivery (2026-11-27T11:39:59.174124+01:00, [instant-eth] catch-up: Including EthereumInboundQueueV2.submit)
- ok: restart: the relayer never screened nonce 11 out
- ok: restart: Bridge Hub's nonce bitmap has nonce 11 set
- ok: the rebuilt verdict cache screens both stranger messages out again (2026-11-27T11:38:45.536259+01:00, 2026-11-27T11:38:45.537717+01:00)
- ok: 4a after restart: the relayer log shows nonce 4 screened out as not ours (2026-11-27T11:38:45.536259+01:00)
- ok: 4a after restart: the relayer never batched nonce 4
- ok: 4a after restart: Bridge Hub's nonce bitmap does not have nonce 4 set
- ok: 4b after restart: the relayer log shows nonce 5 screened out as not ours (2026-11-27T11:38:45.537717+01:00)
- ok: 4b after restart: the relayer never batched nonce 5
- ok: 4b after restart: Bridge Hub's nonce bitmap does not have nonce 5 set
- ok: the dead-nonce store holds only the sentinel: neither our messages nor the strangers' were dead-lettered (9999999)
- ok: the beacon light client keeps advancing after the restart (slot 928 to 1056)

## State left

- registry.relayer() was K2 after S5 and is restored to the deployment's K1 0x5144B40D5460E6B03b06f79b6e61ad3B02316c29 (tx 0xfb483151e380c1b33da2e8c8554756f7e6c3c45197e291f89834e13ad79bf8fe, block 1206), so `.env.local` matches the chain again
- the patched relayer is left running as the stack's only Ethereum to Polkadot relayer; the S4 stranger messages stay pending on Bridge Hub, as designed

## Reverting to the stock relayer

```
snowbridge-poc/setup.sh --revert-relayer
```

This restores `$OUTPUT_DIR/ethereum-v3.json` and `$OUTPUT_DIR/bin/snowbridge-relay` (`OUTPUT_DIR` defaults to `/tmp/snowbridge-v2`) from the `.stock` copies the swap made, by rename, and kills only the ethereum-v3 process; the stack's loop starts it again with the stock config. Done by hand:

```
cp $OUTPUT_DIR/ethereum-v3.json.stock $OUTPUT_DIR/ethereum-v3.json
cp $OUTPUT_DIR/bin/snowbridge-relay.stock $OUTPUT_DIR/bin/snowbridge-relay.new && mv -f $OUTPUT_DIR/bin/snowbridge-relay.new $OUTPUT_DIR/bin/snowbridge-relay
pkill -f "snowbridge-relay run ethereum-v3"
```

After a revert the stock relayer delivers every message its fee rule accepts, including the stranger messages of S4, which stay pending until then (they carry relayer fee 0 and the stock config's minimum fee is 0).

## Notes

- The stack the scenarios ran on was rebuilt from the fork, so the stack's own `snowbridge-relay` is byte-identical to the patched binary. The getcash filter is dormant without a `getcash` block in the config, so the swap is a config change plus a restart of ethereum-v3; the stock behaviour is the config without that block.
- `deploy.ts` passes the admin key to `forge script` with `--private-key`, which shows in `ps`. Acceptable for a local dev key; a production deployment must use a hardware wallet or keystore.
- The trigger and payout services run from source under this harness, each with only its own variables. The trigger key reaches only the trigger service, through an env file it re-reads on SIGHUP; the payout service gets `START_BLOCK` at the Ethereum head and fronts only deposits whose trigger transaction was signed by the registry's relayer at that transaction (S4 asserts it).
- A mined Gateway log, the relayer log and Bridge Hub's nonce bitmap are the three sources of evidence for delivery. The relayer confirms each message with "successfully processed" only on its batch path; on its catch-up path (a beacon update sent together with the message) it logs only "catch-up: Including EthereumInboundQueueV2.submit", so the harness requires the latter.
- S4 messages stay pending on purpose: a public relayer would deliver them. They are the reason the stock relayer must not be reinstated casually.
