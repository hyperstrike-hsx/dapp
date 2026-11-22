// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// 48-hour configuration timelock. The admin multisig is the only proposer/executor/canceller; no admin.
contract ConfigTimelock is TimelockController {
    constructor(address multisig) TimelockController(2 days, one(multisig), one(multisig), address(0)) {}

    function one(address a) private pure returns (address[] memory list) {
        require(a != address(0), "multisig");
        list = new address[](1);
        list[0] = a;
    }
}
