import { BaseError, ContractFunctionRevertedError } from "viem";
import { describeError } from "../common/errors";
import { FeeRefused } from "./fees";

export type Failure =
  | { kind: "rotated" }
  | { kind: "paused" }
  | { kind: "nothing-to-forward" }
  | { kind: "fee"; message: string }
  | { kind: "other"; message: string };

export function classifyFailure(error: unknown): Failure {
  if (error instanceof FeeRefused) return { kind: "fee", message: error.message };
  if (!(error instanceof BaseError)) return { kind: "other", message: describeError(error) };

  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    switch (reverted.data?.errorName) {
      case "NotRelayerOrOwner":
        return { kind: "rotated" };
      case "IsPaused":
        return { kind: "paused" };
      case "NothingToForward":
        return { kind: "nothing-to-forward" };
    }
  }
  return { kind: "other", message: describeError(error) };
}
