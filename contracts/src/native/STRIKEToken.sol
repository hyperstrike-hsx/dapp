// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

contract STRIKEToken is ERC20, ERC20Permit, ERC20Burnable {
    address public immutable bootstrap;
    address public minter;

    event MinterSet(address indexed minter);

    constructor(address setup)
        ERC20("HyperStrike Market Capacity", "STRIKE")
        ERC20Permit("HyperStrike Market Capacity")
    {
        bootstrap = setup;
    }

    function setMinter(address m) external {
        require(msg.sender == bootstrap && minter == address(0) && m.code.length > 0, "minter");
        minter = m;
        emit MinterSet(m);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "minter only");
        _mint(to, amount);
    }
}
