import {
  ASSET_CONVERSION_FEE_DENOMINATOR,
  ASSET_CONVERSION_FEE_NUMERATOR,
  CASH_DECIMALS,
  DESTINATION_EXECUTION_ALLOWANCE,
  FIXED_POINT_SCALE,
  XCM_BASE_DELIVERY_FEE,
  XCM_BYTE_FEE,
  XCM_ENVELOPE_BYTES,
  XCM_FEE_MARGIN_PERCENT,
} from "./constants";

export interface PoolReserves {
  pUsd: bigint;
  pas: bigint;
}

export function divideRoundUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

export function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

export function quoteExactOutput(reserveIn: bigint, reserveOut: bigint, amountOut: bigint): bigint {
  if (amountOut <= 0n || amountOut >= reserveOut) {
    throw new Error("The requested XCM fee exceeds the available pool liquidity.");
  }
  return divideRoundUp(
    reserveIn * amountOut * ASSET_CONVERSION_FEE_DENOMINATOR,
    (reserveOut - amountOut) * ASSET_CONVERSION_FEE_NUMERATOR,
  );
}

export function addXcmFeeMargin(amount: bigint): bigint {
  return divideRoundUp(amount * (100n + XCM_FEE_MARGIN_PERCENT), 100n);
}

export function remoteExecutionFeeWithMargin(): bigint {
  return addXcmFeeMargin(DESTINATION_EXECUTION_ALLOWANCE);
}

export function deliveryFeeForEncodedXcm(encodedLength: number, deliveryFactor: bigint): bigint {
  return divideRoundUp(
    (XCM_BASE_DELIVERY_FEE + XCM_BYTE_FEE * (BigInt(encodedLength) + XCM_ENVELOPE_BYTES)) *
      deliveryFactor,
    FIXED_POINT_SCALE,
  );
}

export function nativeFeeToPUsd(partialFeeNative: bigint, rate: bigint): bigint {
  return divideRoundUp(partialFeeNative * FIXED_POINT_SCALE, rate);
}

export function formatPUsd(amount: bigint): string {
  const scale = 10n ** BigInt(CASH_DECIMALS);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(CASH_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
