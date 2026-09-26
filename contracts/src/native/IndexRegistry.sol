// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProtocolAccess} from "./ProtocolAccess.sol";

contract IndexRegistry {
    ProtocolAccess public immutable access;

    struct Version {
        bytes32 id;
        uint64 activatesAt;
        bytes32 methodologyHash;
        bytes32 compositionRoot;
    }

    mapping(bytes32 => bool) public canonical;
    mapping(bytes32 => bool) public incident;
    mapping(bytes32 => Version[]) private versions;

    event VersionScheduled(
        bytes32 indexed indexId,
        bytes32 indexed versionId,
        uint64 activatesAt,
        bytes32 methodologyHash,
        bytes32 compositionRoot
    );
    event Incident(bytes32 indexed indexId, bool active, bytes32 reportHash);

    constructor(ProtocolAccess a) {
        access = a;
        canonical[keccak256("HS-CS50")] = true;
        canonical[keccak256("HS-KNIFE20")] = true;
        canonical[keccak256("HS-GLOVE10")] = true;
        canonical[keccak256("HS-BLUE20")] = true;
        canonical[keccak256("HS-CASE20")] = true;
    }

    function schedule(bytes32 indexId, Version calldata v) external {
        require(access.hasRole(access.ORACLE_ADMIN_ROLE(), msg.sender), "role");
        require(
            canonical[indexId] && v.id != bytes32(0) && v.methodologyHash != bytes32(0)
                && v.compositionRoot != bytes32(0),
            "version"
        );
        require(v.activatesAt >= block.timestamp + 7 days, "announcement");
        Version[] storage list = versions[indexId];
        if (list.length > 0) {
            require(v.activatesAt > list[list.length - 1].activatesAt && v.id != list[list.length - 1].id, "order");
        }
        list.push(v);
        emit VersionScheduled(indexId, v.id, v.activatesAt, v.methodologyHash, v.compositionRoot);
    }

    function versionAt(bytes32 indexId, uint64 timestamp) public view returns (bytes32) {
        Version[] storage list = versions[indexId];
        for (uint256 i = list.length; i > 0; i--) {
            if (list[i - 1].activatesAt <= timestamp) return list[i - 1].id;
        }
        return bytes32(0);
    }

    function compositionAt(bytes32 indexId, uint64 timestamp) external view returns (bytes32) {
        Version[] storage list = versions[indexId];
        for (uint256 i = list.length; i > 0; i--) {
            if (list[i - 1].activatesAt <= timestamp) return list[i - 1].compositionRoot;
        }
        return bytes32(0);
    }

    function setIncident(bytes32 indexId, bool active, bytes32 reportHash) external {
        require(
            (access.hasRole(access.ORACLE_ADMIN_ROLE(), msg.sender)||(active&&access.hasRole(access.PAUSER_ROLE(),msg.sender))) && canonical[indexId] && reportHash != bytes32(0),
            "incident"
        );
        incident[indexId] = active;
        emit Incident(indexId, active, reportHash);
    }
}
