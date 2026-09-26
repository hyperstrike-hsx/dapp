// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library ProtocolTypes {
    enum Template {
        LEVEL,
        MOVE
    }
    enum Direction {
        UP,
        DOWN
    }
    enum Expiry {
        DAILY,
        WEEKLY,
        MONTHLY
    }
    enum State {
        OPEN,
        LOCKED,
        AWAITING_ORACLE,
        PROPOSED,
        RESOLVED_YES,
        RESOLVED_NO,
        INVALID
    }

    struct Definition {
        Template template;
        bytes32 indexId;
        Direction direction;
        int192 thresholdE8;
        uint64 creationReferenceTime;
        uint192 creationReferenceValueE8;
        uint64 tradeCloseTime;
        uint64 resolutionTime;
        bytes32 settlementPolicyId;
    }

    struct Observation {
        bytes32 indexId;
        bytes32 versionId;
        uint64 observedAt;
        uint192 valueE8;
        uint32 confidenceBps;
        bytes32 constituentRoot;
        bytes32 sourceDataRoot;
        uint64 sequence;
    }

    function key(Definition memory d) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                d.template,
                d.indexId,
                d.direction,
                d.thresholdE8,
                d.creationReferenceValueE8,
                d.resolutionTime,
                d.settlementPolicyId
            )
        );
    }

    function yes(Definition memory d, uint192 value) internal pure returns (bool) {
        int256 result = d.template == Template.LEVEL
            ? int256(uint256(value))
            : (int256(uint256(value)) - int256(uint256(d.creationReferenceValueE8))) * 100e8
                / int256(uint256(d.creationReferenceValueE8));
        return d.direction == Direction.UP
            ? result >= d.thresholdE8
            : result <= (d.template == Template.LEVEL ? d.thresholdE8 : -d.thresholdE8);
    }
}
