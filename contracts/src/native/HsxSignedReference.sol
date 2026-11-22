// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {OracleSignerRegistry} from "./OracleSignerRegistry.sol";
import {IHsxTwap} from "./HsxPriceOracle.sol";

/// Independent HSX/USD reference attested by the oracle signer quorum. Cross-checked against the pool TWAP.
contract HsxSignedReference is EIP712, IHsxTwap {
    bytes32 public constant REFERENCE_TYPEHASH =
        keccak256("HsxReference(uint192 usdE8,uint64 observedAt,uint64 sequence)");
    OracleSignerRegistry public immutable signers;

    struct Reference {
        uint192 usdE8;
        uint64 observedAt;
        uint64 sequence;
    }

    Reference public latest;

    event ReferencePublished(uint192 usdE8, uint64 observedAt, uint64 sequence, bytes32 digest);

    constructor(OracleSignerRegistry s) EIP712("HyperStrike HSX Reference", "1") {
        signers = s;
    }

    function digest(Reference calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REFERENCE_TYPEHASH, r.usdE8, r.observedAt, r.sequence)));
    }

    function publish(Reference calldata r, bytes[] calldata signatures) external {
        require(
            r.usdE8 > 0 && r.observedAt <= block.timestamp && block.timestamp - r.observedAt <= 120, "value/freshness"
        );
        require(r.sequence > latest.sequence && r.observedAt > latest.observedAt, "replay");
        bytes32 hash = digest(r);
        require(signatures.length >= signers.quorum(), "quorum");
        address previous;
        for (uint256 i; i < signatures.length; i++) {
            address recovered = ECDSA.recover(hash, signatures[i]);
            require(recovered > previous && signers.signer(recovered), "signatures");
            previous = recovered;
        }
        latest = r;
        emit ReferencePublished(r.usdE8, r.observedAt, r.sequence, hash);
    }

    function consult() external view returns (uint192 usdE8, uint64 observedAt) {
        return (latest.usdE8, latest.observedAt);
    }
}
