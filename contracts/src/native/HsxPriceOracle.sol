// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProtocolAccess} from "./ProtocolAccess.sol";

interface IHsxTwap {
    function consult() external view returns (uint192 usdE8, uint64 observedAt);
}
// Requires an independently implemented, reviewed pool TWAP adapter AND quorum reference.
// It intentionally cannot be configured with an instantaneous spot price by StrikeMinter.

contract HsxPriceOracle {
    ProtocolAccess public immutable access;
    IHsxTwap public immutable twap;
    IHsxTwap public immutable referenceOracle;
    uint256 public constant MAX_AGE = 15 minutes;
    uint256 public constant MAX_DEVIATION_BPS = 1000;

    constructor(ProtocolAccess a, IHsxTwap t, IHsxTwap r) {
        require(address(t).code.length > 0 && address(r).code.length > 0 && t != r, "independent sources");
        access = a;
        twap = t;
        referenceOracle = r;
    }

    function price() external view returns (uint192 usdE8, uint64 observedAt) {
        (uint192 a, uint64 ta) = twap.consult();
        (uint192 b, uint64 tb) = referenceOracle.consult();
        require(
            a > 0 && b > 0 && ta <= block.timestamp && tb <= block.timestamp && block.timestamp - ta <= MAX_AGE
                && block.timestamp - tb <= MAX_AGE,
            "unsafe HSX reference"
        );
        uint256 difference = a > b ? a - b : b - a;
        require(difference * 10000 <= uint256(b) * MAX_DEVIATION_BPS, "HSX deviation");
        return (a < b ? a : b, ta < tb ? ta : tb); // conservative burn quote
    }
}
