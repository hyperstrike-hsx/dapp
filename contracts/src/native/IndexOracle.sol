// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IndexRegistry} from "./IndexRegistry.sol";
import {OracleSignerRegistry} from "./OracleSignerRegistry.sol";
import {ProtocolTypes as T} from "./ProtocolTypes.sol";

contract IndexOracle is EIP712 {
    bytes32 public constant OBSERVATION_TYPEHASH = keccak256(
        "IndexObservation(bytes32 indexId,bytes32 versionId,uint64 observedAt,uint192 valueE8,uint32 confidenceBps,bytes32 constituentRoot,bytes32 sourceDataRoot,uint64 sequence)"
    );
    IndexRegistry public immutable registry;
    OracleSignerRegistry public immutable signers;
    mapping(bytes32 => T.Observation) private latestObservation;
    mapping(bytes32 => mapping(uint64 => T.Observation)) private observations;
    mapping(bytes32 => bool) public usedDigest;

    event Published(
        bytes32 indexed indexId,
        uint64 indexed observedAt,
        uint64 sequence,
        bytes32 digest,
        uint192 valueE8,
        uint32 confidenceBps
    );

    constructor(IndexRegistry r, OracleSignerRegistry s) EIP712("HyperStrike Index Oracle", "1") {
        registry = r;
        signers = s;
    }

    function digest(T.Observation calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OBSERVATION_TYPEHASH,
                    o.indexId,
                    o.versionId,
                    o.observedAt,
                    o.valueE8,
                    o.confidenceBps,
                    o.constituentRoot,
                    o.sourceDataRoot,
                    o.sequence
                )
            )
        );
    }

    function publish(T.Observation calldata o, bytes[] calldata signatures) external {
        require(
            registry.canonical(o.indexId) && o.versionId != bytes32(0)
                && registry.versionAt(o.indexId, o.observedAt) == o.versionId
                && registry.compositionAt(o.indexId, o.observedAt) == o.constituentRoot,
            "index/version"
        );
        require(
            o.valueE8 > 0 && o.confidenceBps <= 10000 && o.constituentRoot != bytes32(0)
                && o.sourceDataRoot != bytes32(0),
            "observation"
        );
        require(
            o.observedAt <= block.timestamp && block.timestamp - o.observedAt <= 90 && o.observedAt % 300 == 0,
            "cadence/freshness"
        );
        require(
            o.sequence > latestObservation[o.indexId].sequence && o.observedAt > latestObservation[o.indexId].observedAt,
            "replay"
        );
        bytes32 hash = digest(o);
        require(!usedDigest[hash] && signatures.length >= signers.quorum(), "digest/quorum");
        address previous;
        for (uint256 i; i < signatures.length; i++) {
            address recovered = ECDSA.recover(hash, signatures[i]);
            require(recovered > previous && signers.signer(recovered), "signatures");
            previous = recovered;
        }
        usedDigest[hash] = true;
        latestObservation[o.indexId] = o;
        observations[o.indexId][o.observedAt] = o;
        emit Published(o.indexId, o.observedAt, o.sequence, hash, o.valueE8, o.confidenceBps);
    }

    function latest(bytes32 indexId) external view returns (T.Observation memory) {
        return latestObservation[indexId];
    }

    function at(bytes32 indexId, uint64 timestamp) external view returns (T.Observation memory) {
        return observations[indexId][timestamp];
    }
}
