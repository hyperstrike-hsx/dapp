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
    // Five-minute slots whose observations the resolution committee has declared unusable.
    mapping(bytes32 => mapping(uint64 => bool)) public voided;
    mapping(bytes32 => Version[]) private versions;

    event VersionScheduled(
        bytes32 indexed indexId,
        bytes32 indexed versionId,
        uint64 activatesAt,
        bytes32 methodologyHash,
        bytes32 compositionRoot
    );
    event Incident(bytes32 indexed indexId, bool active, bytes32 reportHash);
    event SlotsVoided(bytes32 indexed indexId, uint64 from, uint64 to, bytes32 reportHash);

    /// Genesis versions (canonical order CS50, KNIFE20, GLOVE10, BLUE20, CASE20) activate at deployment:
    /// no market exists yet, so there is nothing to announce against. Later versions keep 7-day notice.
    constructor(ProtocolAccess a, bytes32[5] memory versionIds, bytes32[5] memory compositionRoots, bytes32 methodology)
    {
        access = a;
        require(methodology != bytes32(0), "methodology");
        bytes32[5] memory ids = [
            keccak256("HS-CS50"),
            keccak256("HS-KNIFE20"),
            keccak256("HS-GLOVE10"),
            keccak256("HS-BLUE20"),
            keccak256("HS-CASE20")
        ];
        for (uint256 i; i < 5; i++) {
            require(versionIds[i] != bytes32(0) && compositionRoots[i] != bytes32(0), "genesis");
            canonical[ids[i]] = true;
            versions[ids[i]].push(Version(versionIds[i], uint64(block.timestamp), methodology, compositionRoots[i]));
            emit VersionScheduled(ids[i], versionIds[i], uint64(block.timestamp), methodology, compositionRoots[i]);
        }
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

    /// The incident flag only halts creation and trading going forward. It never reaches back into
    /// settlement: a lone pauser must not be able to turn a correctly observed result into INVALID.
    /// Bad data is removed slot by slot here, by the resolution committee, with a published report.
    function voidSlots(bytes32 indexId, uint64 from, uint64 to, bytes32 reportHash) external {
        require(access.hasRole(access.RESOLUTION_ROLE(), msg.sender), "role");
        require(
            canonical[indexId] && reportHash != bytes32(0) && from % 300 == 0 && to % 300 == 0 && from <= to
                && to - from <= 6 hours && to <= block.timestamp && block.timestamp - from <= 2 days,
            "range"
        );
        for (uint64 ts = from; ts <= to; ts += 300) voided[indexId][ts] = true;
        emit SlotsVoided(indexId, from, to, reportHash);
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
