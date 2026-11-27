// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {Forwarder} from "../../src/Forwarder.sol";
import {ISnowbridgeGatewayV2} from "../../src/interfaces/IExternal.sol";
import {IForwarder} from "../../src/interfaces/IForwarding.sol";
import {Router} from "../../src/Router.sol";

contract MockERC20 is ERC20 {
    constructor(string memory symbol) ERC20(symbol, symbol) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Reproduces mainnet USDT's deviations from ERC-20: no return values, and `approve` refuses to
///      change a non-zero allowance to another non-zero value.
contract MockTether {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "USDT: reset allowance first");
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

interface ITransferFrom {
    function transferFrom(address from, address to, uint256 amount) external;
}

struct GatewayCall {
    address sender;
    bytes xcm;
    bytes claimer;
    address token;
    uint128 amount;
    uint128 executionFee;
    uint128 relayerFee;
    uint256 value;
}

/// @dev Mirrors the checks of Snowbridge's `Gateway.v2_sendMessage` and pulls the tokens from the caller the same
///      way (`transferFrom` into the agent, then a balance check), and records every call.
contract MockGateway is ISnowbridgeGatewayV2 {
    error ExceededMaximumValue();
    error InsufficientValue();
    error TooManyAssets();
    error InvalidAsset();
    error InvalidAmount();
    error InvalidToken();

    address public immutable AGENT = address(uint160(uint256(keccak256("mock asset hub agent"))));
    GatewayCall[] public calls;

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function last() external view returns (GatewayCall memory) {
        return calls[calls.length - 1];
    }

    function callAt(uint256 index) external view returns (GatewayCall memory) {
        return calls[index];
    }

    function v2_sendMessage(
        bytes calldata xcm,
        bytes[] calldata assets,
        bytes calldata claimer,
        uint128 executionFee,
        uint128 relayerFee
    ) external payable {
        if (msg.value > type(uint128).max) revert ExceededMaximumValue();
        if (msg.value < uint256(executionFee) + relayerFee) revert InsufficientValue();
        payable(AGENT).transfer(msg.value);

        if (assets.length > 8) revert TooManyAssets();
        address token;
        uint128 amount;
        for (uint256 i; i < assets.length; ++i) {
            if (uint8(assets[i][31]) != 0) revert InvalidAsset();
            (, token, amount) = abi.decode(assets[i], (uint8, address, uint128));
            if (token.code.length == 0) revert InvalidToken();
            if (amount == 0) revert InvalidAmount();
            uint256 before = ERC20(token).balanceOf(AGENT);
            ITransferFrom(token).transferFrom(msg.sender, AGENT, amount);
            if (ERC20(token).balanceOf(AGENT) != before + amount) revert InvalidToken();
        }

        calls.push(GatewayCall(msg.sender, xcm, claimer, token, amount, executionFee, relayerFee, msg.value));
    }
}

/// @dev Looks like a forwarder to the router: same `ACCOUNT()` as its victim, and it tries to spend the victim's
///      allowance to the router.
contract FakeForwarder is IForwarder {
    bytes32 public ACCOUNT;

    constructor(bytes32 account) {
        ACCOUNT = account;
    }

    function attack(Router router, address token, uint256 amount) external payable {
        router.send{value: msg.value}(token, amount, uint128(msg.value), 0);
    }
}

/// @dev A token whose ERC-20 calls run a trigger of another forwarder, whose owner is this token. `fireAt` numbers
///      the call that does it: the nth `approve` or the nth `transferFrom`, counting every caller.
contract HookToken is ERC20 {
    enum Hook {
        None,
        Approve,
        TransferFrom
    }

    Hook public hook;
    uint256 public fireAt;
    Forwarder public target;
    address public targetToken;
    bool public swallow;

    uint256 private approvals;
    uint256 private transfers;
    bool private fired;

    constructor() ERC20("H", "H") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(Hook hook_, uint256 fireAt_, Forwarder target_, address targetToken_, bool swallow_) external {
        (hook, fireAt, target, targetToken, swallow) = (hook_, fireAt_, target_, targetToken_, swallow_);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (hook == Hook.Approve && ++approvals == fireAt) _nest();
        return super.approve(spender, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (hook == Hook.TransferFrom && ++transfers == fireAt) _nest();
        return super.transferFrom(from, to, value);
    }

    function _nest() private {
        if (fired) return;
        fired = true;
        if (swallow) {
            try target.trigger(targetToken, 0, 0) {} catch {}
        } else {
            target.trigger(targetToken, 0, 0);
        }
    }
}

/// @dev A trigger key that triggers two forwarders in one transaction.
contract Batcher {
    function trigger2(Forwarder first, Forwarder second, address token) external {
        first.trigger(token, 0, 0);
        second.trigger(token, 0, 0);
    }
}

/// @dev `balanceOf` is declared `view`, so the forwarder and the Gateway call it with STATICCALL and a nested trigger
///      has to fail. Minimal ERC-20 otherwise.
contract BalanceHookToken {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowance;
    Forwarder public target;
    address public targetToken;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function arm(Forwarder target_, address targetToken_) external {
        (target, targetToken) = (target_, targetToken_);
    }

    function balanceOf(address who) external returns (uint256) {
        if (address(target) != address(0)) target.trigger(targetToken, 0, 0);
        return balances[who];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        balances[from] -= value;
        balances[to] += value;
        return true;
    }
}
