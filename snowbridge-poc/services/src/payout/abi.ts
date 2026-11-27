import { parseAbi } from "viem";

export const routerSentAbi = parseAbi(["event Sent(uint256 indexed depositId, bytes32 indexed account, address token, uint256 amount)"]);

export const poolAbi = parseAbi([
  "function front(uint256 depositId, bytes32 account, address token, uint256 amount, uint256 fee)",
  "function state(uint256 depositId, bytes32 account, address token, uint256 amount) view returns (uint8 state, address payer)",
  "function funds(address payer, address token) view returns (uint256)",
  "function BRIDGE_FEE() view returns (uint256)",
  "function FRONT_FEE_CAP_BPS() view returns (uint16)",
  "event Fronted(uint256 indexed depositId, address indexed payer, bytes32 account, address token, uint256 amount, uint256 fee)",
  "event Settled(uint256 indexed depositId, bool repaid, address to, uint256 amount)",
  "error NotSettler()",
  "error UnsupportedToken()",
  "error InsufficientFunds()",
  "error TransferFailed()",
  "error AlreadyFronted()",
  "error AlreadySettled()",
  "error FeeOutOfRange()",
  "error FeeCapTooHigh()",
]);

export const DepositStatus = { None: 0, Fronted: 1, Settled: 2 } as const;
