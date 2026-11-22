// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHsxTwap} from "./HsxPriceOracle.sol";

interface IV3PoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

/**
 * HSX/USD from the HSX/WHYPE concentrated-liquidity pool's 30-minute arithmetic-mean tick, multiplied by
 * the HyperCore HYPE oracle price (read precompile). Never a spot read: StrikeMinter burn quotes cannot be
 * moved inside one block. An inactive pool legitimately returns its last traded tick.
 */
contract HsxV3Twap is IHsxTwap {
    uint32 public constant WINDOW = 30 minutes;
    address public constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    IV3PoolOracle public immutable pool;
    bool public immutable hsxIsToken1;
    uint32 public immutable perpIndex;
    uint256 public immutable pxScaleE8; // raw precompile price * pxScaleE8 = quote-asset USD, 8 decimals

    constructor(IV3PoolOracle p, address hsx, address wrappedQuote, uint32 perp, uint256 scale) {
        address t0 = p.token0();
        address t1 = p.token1();
        require((t0 == hsx && t1 == wrappedQuote) || (t1 == hsx && t0 == wrappedQuote), "pool tokens");
        require(
            IERC20Metadata(hsx).decimals() == 18 && IERC20Metadata(wrappedQuote).decimals() == 18 && scale > 0
                && scale <= 1e8,
            "decimals/scale"
        );
        pool = p;
        hsxIsToken1 = t1 == hsx;
        perpIndex = perp;
        pxScaleE8 = scale;
    }

    function quoteUsdE8() public view returns (uint256) {
        (bool ok, bytes memory out) = ORACLE_PX_PRECOMPILE.staticcall(abi.encode(perpIndex));
        require(ok && out.length == 32, "oracle precompile");
        uint256 raw = abi.decode(out, (uint256));
        require(raw > 0 && raw <= type(uint64).max, "oracle price");
        return raw * pxScaleE8;
    }

    function meanTick() public view returns (int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = WINDOW;
        (int56[] memory cumulative,) = pool.observe(ago);
        int56 delta = cumulative[1] - cumulative[0];
        tick = int24(delta / int56(uint56(WINDOW)));
        if (delta < 0 && delta % int56(uint56(WINDOW)) != 0) tick--; // round toward negative infinity
    }

    /// Quote-asset wei paid for 1e18 HSX at the mean tick.
    function hsxInQuoteWei() public view returns (uint256) {
        uint256 sqrtP = getSqrtRatioAtTick(meanTick());
        // token1/token0 price = sqrtP^2 / 2^192. Split the shift to stay inside 256 bits.
        if (sqrtP <= type(uint128).max) {
            uint256 ratioX192 = sqrtP * sqrtP;
            return hsxIsToken1 ? Math.mulDiv(1 << 192, 1e18, ratioX192) : Math.mulDiv(ratioX192, 1e18, 1 << 192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64);
        return hsxIsToken1 ? Math.mulDiv(1 << 128, 1e18, ratioX128) : Math.mulDiv(ratioX128, 1e18, 1 << 128);
    }

    function consult() external view returns (uint192 usdE8, uint64 observedAt) {
        uint256 value = Math.mulDiv(hsxInQuoteWei(), quoteUsdE8(), 1e18);
        require(value > 0 && value <= type(uint192).max, "HSX price");
        return (uint192(value), uint64(block.timestamp));
    }

    /// Uniswap V3 TickMath.getSqrtRatioAtTick, checked-arithmetic safe.
    function getSqrtRatioAtTick(int24 tick) public pure returns (uint160) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "tick");
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        return uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
