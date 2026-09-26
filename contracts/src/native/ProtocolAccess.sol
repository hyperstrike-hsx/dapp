// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

contract ProtocolAccess is AccessControlDefaultAdminRules {
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
    bytes32 public constant RAIL_ADMIN_ROLE = keccak256("RAIL_ADMIN_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant RESOLUTION_ROLE = keccak256("RESOLUTION_ROLE");
    bool public mintPaused;
    bool public creationPaused;
    bool public tradingPaused;

    event PauseChanged(bool minting, bool creation, bool trading);

    constructor(address multisig) AccessControlDefaultAdminRules(2 days, multisig) {}

    function pause(bool minting, bool creation, bool trading) external onlyRole(PAUSER_ROLE) {
        mintPaused = minting;
        creationPaused = creation;
        tradingPaused = trading;
        emit PauseChanged(minting, creation, trading);
    }
}
