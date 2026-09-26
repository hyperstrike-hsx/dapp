// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library NativeMarketAMM {
    function buy(uint256 own, uint256 other, uint256 gross)
        internal
        pure
        returns (uint256 tokens, uint256 net, uint256 fee)
    {
        require(own > 0 && other > 0 && gross > 0, "liquidity");
        fee = Math.mulDiv(gross, 20, 10000, Math.Rounding.Ceil);
        net = gross - fee;
        tokens = own + net - Math.mulDiv(own, other, other + net, Math.Rounding.Ceil);
        require(tokens > 0, "zero output");
    }

    function sell(uint256 own, uint256 other, uint256 tokens)
        internal
        pure
        returns (uint256 output, uint256 merged, uint256 fee)
    {
        require(own > 0 && other > 0 && tokens > 0, "liquidity");
        // Pilot reserves capped at 1e30, so reserve products cannot overflow.
        require(own + tokens <= 1e30 && other <= 1e30, "reserve bound");
        uint256 lo;
        uint256 hi = Math.min(own + tokens, other) - 1;
        uint256 k = own * other;
        while (lo < hi) {
            uint256 m = (lo + hi + 1) / 2;
            if ((own + tokens - m) * (other - m) >= k) lo = m;
            else hi = m - 1;
        }
        merged = lo;
        fee = Math.mulDiv(lo, 20, 10000, Math.Rounding.Ceil);
        output = lo - fee;
        require(output > 0, "zero output");
    }
}
