// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProtocolTypes as T} from "./ProtocolTypes.sol";
import {ProtocolAccess} from "./ProtocolAccess.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {NativeMarketAMM} from "./NativeMarketAMM.sol";
import {FeeVault} from "./FeeVault.sol";

/**
 * Equivalent internal outcome claims; no ERC1155 receiver hooks in the value path.
 * Every split adds the same amount to YES, NO and locked collateral.
 * AMM reserves are claims too, owned by the pool until final redemption.
 * Seed liquidity is locked until finality; creators never withdraw trader backing.
 */
contract NativeBinaryMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    T.Definition private definition_;
    ProtocolAccess public immutable access;
    ProtocolConfig public immutable config;
    IERC20 public immutable collateral;
    FeeVault public immutable fees;
    address public immutable factory;
    address public immutable settlement;
    address public immutable creator;
    bytes32 public immutable marketKey;
    uint256[2] public reserve;
    uint256[2] public totalClaims;
    mapping(address => mapping(uint8 => uint256)) public balanceOf;
    uint256 public lockedCollateral;
    T.State private state_;
    bool public initialized;

    event Seeded(address indexed creator, uint256 amount);
    event Traded(address indexed trader, uint8 side, bool buy, uint256 collateralAmount, uint256 tokens, uint256 fee);
    event StateChanged(T.State state);
    event Redeemed(address indexed account, uint256 yesAmount, uint256 noAmount, uint256 payout);

    constructor(T.Definition memory d, ProtocolAccess a, ProtocolConfig c, FeeVault f, address s, address owner) {
        definition_ = d;
        access = a;
        config = c;
        collateral = IERC20(address(c.collateral()));
        fees = f;
        settlement = s;
        creator = owner;
        factory = msg.sender;
        marketKey = T.key(d);
        collateral.forceApprove(address(f), type(uint256).max);
    }

    function definition() external view returns (T.Definition memory) {
        return definition_;
    }

    function state() public view returns (T.State) {
        if (uint8(state_) >= uint8(T.State.PROPOSED)) return state_;
        if (block.timestamp >= definition_.resolutionTime) return T.State.AWAITING_ORACLE;
        if (block.timestamp >= definition_.tradeCloseTime) return T.State.LOCKED;
        return T.State.OPEN;
    }

    function seed(uint256 amount) external nonReentrant {
        require(msg.sender == factory && !initialized && amount > 0 && amount <= config.pilotCap(), "seed");
        require(collateral.balanceOf(address(this)) == amount, "seed funding");
        initialized = true;
        reserve = [amount, amount];
        totalClaims = [amount, amount];
        lockedCollateral = amount;
        emit Seeded(creator, amount);
    }

    function quoteBuy(uint8 side, uint256 gross) public view returns (uint256 tokens, uint256 net, uint256 fee) {
        require(side < 2, "side");
        return NativeMarketAMM.buy(reserve[side], reserve[1 - side], gross);
    }

    function quoteSell(uint8 side, uint256 tokens) public view returns (uint256 output, uint256 merged, uint256 fee) {
        require(side < 2, "side");
        return NativeMarketAMM.sell(reserve[side], reserve[1 - side], tokens);
    }

    function checkTrade(uint64 deadline) private view {
        require(
            initialized && state() == T.State.OPEN && !access.tradingPaused()
                && !config.oracle().registry().incident(definition_.indexId) && block.timestamp <= deadline,
            "closed/paused/expired"
        );
    }

    function buy(uint8 side, uint256 gross, uint256 minOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 tokens)
    {
        checkTrade(deadline);
        uint256 net;
        uint256 fee;
        (tokens, net, fee) = quoteBuy(side, gross);
        uint256 beforeProbability=reserve[1-side]*10000/(reserve[0]+reserve[1]);
        uint256 afterProbability=(reserve[1-side]+net)*10000/(reserve[0]+reserve[1]+net*2-tokens);
        require(afterProbability-beforeProbability<=config.maxPriceImpactBps(),"price impact");
        require(tokens >= minOut && minOut > 0 && lockedCollateral + net <= config.pilotCap(), "slippage/cap");
        uint256 prior = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), gross);
        require(collateral.balanceOf(address(this)) - prior == gross, "unsupported collateral");
        lockedCollateral += net;
        totalClaims[0] += net;
        totalClaims[1] += net;
        reserve[0] += net;
        reserve[1] += net;
        reserve[side] -= tokens;
        balanceOf[msg.sender][side] += tokens;
        fees.deposit(creator, fee);
        emit Traded(msg.sender, side, true, gross, tokens, fee);
        assertSolvent();
    }

    function sell(uint8 side, uint256 tokens, uint256 minOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 output)
    {
        checkTrade(deadline);
        require(side < 2 && balanceOf[msg.sender][side] >= tokens, "balance");
        uint256 merged;
        uint256 fee;
        (output, merged, fee) = quoteSell(side, tokens);
        uint256 beforeProbability=reserve[1-side]*10000/(reserve[0]+reserve[1]);
        uint256 afterProbability=(reserve[1-side]-merged)*10000/(reserve[0]+reserve[1]+tokens-merged*2);
        require(beforeProbability-afterProbability<=config.maxPriceImpactBps(),"price impact");
        require(output >= minOut && minOut > 0, "slippage");
        balanceOf[msg.sender][side] -= tokens;
        reserve[side] += tokens;
        reserve[0] -= merged;
        reserve[1] -= merged;
        totalClaims[0] -= merged;
        totalClaims[1] -= merged;
        lockedCollateral -= merged;
        fees.deposit(creator, fee);
        collateral.safeTransfer(msg.sender, output);
        emit Traded(msg.sender, side, false, output, tokens, fee);
        assertSolvent();
    }

    function setState(T.State next) external {
        require(msg.sender == settlement && uint8(next) >= uint8(T.State.PROPOSED), "settlement");
        require(uint8(state_) < uint8(T.State.RESOLVED_YES) && uint8(next) > uint8(state_), "monotonic");
        require(block.timestamp >= definition_.resolutionTime + 300, "early");
        state_ = next;
        emit StateChanged(next);
    }

    function redeem() external nonReentrant returns (uint256 payout) {
        uint256 y = balanceOf[msg.sender][0];
        uint256 n = balanceOf[msg.sender][1];
        require(y + n > 0, "empty");
        balanceOf[msg.sender][0] = 0;
        balanceOf[msg.sender][1] = 0;
        payout = redeemClaims(y, n);
        collateral.safeTransfer(msg.sender, payout);
        emit Redeemed(msg.sender, y, n, payout);
    }

    function redeemPool() external nonReentrant returns (uint256 payout) {
        require(msg.sender == creator, "creator");
        uint256 y = reserve[0];
        uint256 n = reserve[1];
        require(y + n > 0, "empty");
        reserve = [uint256(0), uint256(0)];
        payout = redeemClaims(y, n);
        collateral.safeTransfer(creator, payout);
        emit Redeemed(creator, y, n, payout);
    }

    function redeemClaims(uint256 y, uint256 n) private returns (uint256 payout) {
        require(uint8(state_) >= uint8(T.State.RESOLVED_YES), "not final");
        payout = state_ == T.State.INVALID ? (y + n) / 2 : state_ == T.State.RESOLVED_YES ? y : n;
        totalClaims[0] -= y;
        totalClaims[1] -= n;
        lockedCollateral -= payout;
        assertSolvent();
    }

    function sweepDust() external nonReentrant {
        require(
            totalClaims[0] == 0 && totalClaims[1] == 0 && uint8(state_) >= uint8(T.State.RESOLVED_YES),
            "liability remains"
        );
        uint256 dust = collateral.balanceOf(address(this));
        lockedCollateral = 0;
        collateral.safeTransfer(fees.treasury(), dust);
    }

    function assertSolvent() private view {
        require(lockedCollateral >= liability() && collateral.balanceOf(address(this)) >= lockedCollateral, "insolvent");
    }

    function liability() public view returns (uint256) {
        return state_ == T.State.INVALID
            ? Math.ceilDiv(totalClaims[0] + totalClaims[1], 2)
            : state_ == T.State.RESOLVED_YES
                ? totalClaims[0]
                : state_ == T.State.RESOLVED_NO ? totalClaims[1] : Math.max(totalClaims[0], totalClaims[1]);
    }
}
