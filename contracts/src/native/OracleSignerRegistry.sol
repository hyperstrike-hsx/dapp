// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProtocolAccess} from "./ProtocolAccess.sol";

contract OracleSignerRegistry {
    ProtocolAccess public immutable access;
    mapping(address => bool) public signer;
    uint256 public signerCount;
    uint256 public quorum;

    event SignerChanged(address indexed account, bool active);

    constructor(ProtocolAccess a, address[3] memory initial) {
        access = a;
        quorum = 2;
        for (uint256 i; i < 3; i++) {
            require(initial[i] != address(0) && !signer[initial[i]], "signer");
            signer[initial[i]] = true;
            signerCount++;
            emit SignerChanged(initial[i], true);
        }
    }

    function configure(address account, bool active, uint256 nextQuorum) external {
        require(access.hasRole(access.ORACLE_ADMIN_ROLE(), msg.sender), "role");
        require(account != address(0), "zero");
        if (signer[account] != active) {
            signer[account] = active;
            signerCount = active ? signerCount + 1 : signerCount - 1;
        }
        require(
            signerCount >= 3 && nextQuorum >= 2 && nextQuorum <= signerCount && nextQuorum * 2 > signerCount, "quorum"
        );
        quorum = nextQuorum;
        emit SignerChanged(account, active);
    }
}
