// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FeeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable collateral;
    address public immutable treasury;
    mapping(address => uint256) public accrued;
    uint256 public totalAccrued;

    event Accrued(address indexed market, address indexed creator, uint256 creatorFee, uint256 protocolFee);
    event Claimed(address indexed account, uint256 amount);

    constructor(IERC20 c, address t) {
        require(t != address(0), "treasury");
        collateral = c;
        treasury = t;
    }

    function deposit(address creator, uint256 amount) external nonReentrant {
        require(creator != address(0), "creator");
        uint256 before_ = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        require(collateral.balanceOf(address(this)) - before_ == amount, "transfer semantics");
        uint256 creatorFee = amount * 30 / 100;
        accrued[creator] += creatorFee;
        accrued[treasury] += amount - creatorFee;
        totalAccrued += amount;
        emit Accrued(msg.sender, creator, creatorFee, amount - creatorFee);
    }

    function claim() external nonReentrant {
        uint256 amount = accrued[msg.sender];
        require(amount > 0, "empty");
        accrued[msg.sender] = 0;
        totalAccrued -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
