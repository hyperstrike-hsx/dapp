// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HsxV3Twap, IV3PoolOracle} from "../src/native/HsxV3Twap.sol";

/// Never deployed. Run as an eth_call with no `to`: the constructor builds the real adapter against
/// live chain state (including the HyperCore oracle precompile, which local forks cannot emulate)
/// and returns what consult() would say. Costs nothing and changes nothing.
contract HsxTwapProbe {
    constructor(IV3PoolOracle pool, address hsx, address wrappedQuote, uint32 perp, uint256 scale) {
        HsxV3Twap twap = new HsxV3Twap(pool, hsx, wrappedQuote, perp, scale);
        (uint192 usdE8, uint64 observedAt) = twap.consult();
        bytes memory out = abi.encode(usdE8, observedAt, twap.meanTick(), twap.quoteUsdE8());
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
