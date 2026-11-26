/** The fields of a chain's `System.Account` value the rule reads. */
export interface NativeAccount {
  consumers: number;
  providers: number;
  data: { free: bigint; reserved: bigint; frozen: bigint };
}

export interface SendableNativeOptions {
  /** Hold the existential deposit back whatever the account's references say. */
  keepAlive?: boolean;
}

/** The most native an account can send, as pallet-balances counts it: the free balance less the
 *  larger of what a freeze holds beyond the reserved and the existential deposit. The latter only
 *  while the account cannot be closed: something holds a consumer reference on it and the balance
 *  is its only provider. */
export function sendableNative(
  account: NativeAccount,
  existentialDeposit: bigint,
  options: SendableNativeOptions = {},
): bigint {
  const { free, reserved, frozen } = account.data;
  const cannotClose = account.consumers > 0 && account.providers <= 1;
  const underFreeze = frozen > reserved ? frozen - reserved : 0n;
  const keptAlive = options.keepAlive || cannotClose ? existentialDeposit : 0n;
  const untouchable = underFreeze > keptAlive ? underFreeze : keptAlive;
  return free > untouchable ? free - untouchable : 0n;
}
