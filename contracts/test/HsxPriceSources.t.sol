// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProtocolAccess} from "../src/native/ProtocolAccess.sol";
import {OracleSignerRegistry} from "../src/native/OracleSignerRegistry.sol";
import {HsxV3Twap, IV3PoolOracle} from "../src/native/HsxV3Twap.sol";
import {HsxSignedReference} from "../src/native/HsxSignedReference.sol";
import {HsxPriceOracle, IHsxTwap} from "../src/native/HsxPriceOracle.sol";

interface VmPx {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function etch(address, bytes calldata) external;
    function expectRevert() external;
}

contract Token18 is ERC20 {
    constructor(string memory s) ERC20(s, s) {}
}

contract MockV3Pool {
    address public token0;
    address public token1;
    int56 public perSecond;
    bool public old;

    constructor(address a, address b) {
        (token0, token1) = (a, b);
    }

    function set(int56 cumulativeDeltaOver1800, bool tooOld) external {
        perSecond = cumulativeDeltaOver1800;
        old = tooOld;
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory c, uint160[] memory l) {
        require(!old && ago.length == 2 && ago[0] == 1800 && ago[1] == 0, "OLD");
        c = new int56[](2);
        l = new uint160[](2);
        c[0] = 1_000_000;
        c[1] = 1_000_000 + perSecond;
    }
}

/// Stand-in for the HyperCore oracle read precompile: returns one stored word for any input.
contract MockOraclePx {
    uint256 public raw;

    function set(uint256 v) external {
        raw = v;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(raw);
    }
}

contract HsxPriceSourcesTest {
    VmPx vm = VmPx(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000807;
    Token18 whype;
    Token18 hsx;
    MockV3Pool pool;
    HsxV3Twap twap;
    OracleSignerRegistry signers;
    HsxSignedReference ref;

    function setUp() public {
        vm.warp(1795263000);
        whype = new Token18("WHYPE");
        hsx = new Token18("HSX");
        pool = new MockV3Pool(address(whype), address(hsx));
        vm.etch(PRECOMPILE, address(new MockOraclePx()).code);
        MockOraclePx(PRECOMPILE).set(597120);
        twap = new HsxV3Twap(IV3PoolOracle(address(pool)), address(hsx), address(whype), 159, 1e4);
        ProtocolAccess access = new ProtocolAccess(address(this));
        signers = new OracleSignerRegistry(access, [vm.addr(1), vm.addr(2), vm.addr(3)]);
        ref = new HsxSignedReference(signers);
    }

    function testTickMathMatchesUniswapReferenceValues() public view {
        require(twap.getSqrtRatioAtTick(0) == 79228162514264337593543950336, "tick 0");
        require(twap.getSqrtRatioAtTick(-887272) == 4295128739, "min");
        require(twap.getSqrtRatioAtTick(887272) == 1461446703485210103287273052203988822378723970342, "max");
        // Live pool at fork time: tick 149686 <-> sqrtPriceX96 1.4097e32 (same tick bucket).
        uint256 live = 140970247759676520281042271956412;
        require(twap.getSqrtRatioAtTick(149686) <= live && twap.getSqrtRatioAtTick(149687) > live, "live tick");
    }

    function testLiveNumbersGiveExpectedUsdPrice() public {
        pool.set(int56(149686) * 1800, false);
        require(twap.meanTick() == 149686, "mean tick");
        (uint192 usdE8, uint64 at_) = twap.consult();
        // $59.712 per HYPE / ~3.166M HSX per HYPE = ~$0.0000189
        require(usdE8 >= 1880 && usdE8 <= 1892 && at_ == block.timestamp, "live HSX price");
    }

    function testNegativeMeanTickRoundsDownAndOrderIsRespected() public {
        MockV3Pool flipped = new MockV3Pool(address(hsx), address(whype));
        HsxV3Twap t = new HsxV3Twap(IV3PoolOracle(address(flipped)), address(hsx), address(whype), 159, 1e4);
        flipped.set(-int56(149686) * 1800 - 1, false);
        require(t.meanTick() == -149687, "floor");
        flipped.set(-int56(149686) * 1800, false);
        (uint192 a,) = t.consult();
        pool.set(int56(149686) * 1800, false);
        (uint192 b,) = twap.consult();
        require(a >= b - 1 && a <= b + 1, "token order symmetric");
    }

    function testRejectsBadPrecompileShortHistoryAndForeignPool() public {
        pool.set(int56(149686) * 1800, false);
        MockOraclePx(PRECOMPILE).set(0);
        vm.expectRevert();
        twap.consult();
        vm.etch(PRECOMPILE, hex"");
        vm.expectRevert(); // empty return data from a missing precompile
        twap.consult();
        vm.etch(PRECOMPILE, address(new MockOraclePx()).code);
        MockOraclePx(PRECOMPILE).set(597120);
        pool.set(int56(149686) * 1800, true);
        vm.expectRevert();
        twap.consult();
        Token18 other = new Token18("X");
        vm.expectRevert();
        new HsxV3Twap(IV3PoolOracle(address(pool)), address(hsx), address(other), 159, 1e4);
    }

    function sign(HsxSignedReference.Reference memory r, uint256 a, uint256 b) private returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        bytes32 digest = ref.digest(r);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(a, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(b, digest);
        bool ordered = vm.addr(a) < vm.addr(b);
        sigs[ordered ? 0 : 1] = abi.encodePacked(r1, s1, v1);
        sigs[ordered ? 1 : 0] = abi.encodePacked(r2, s2, v2);
    }

    function testSignedReferenceQuorumFreshnessAndReplay() public {
        uint64 t0 = 1795263000; // explicit clock: via-IR may cache block.timestamp across warps
        HsxSignedReference.Reference memory r = HsxSignedReference.Reference(1886, t0, 1);
        vm.expectRevert(); // no quorum
        ref.publish(r, new bytes[](0));
        bytes[] memory dup = sign(r, 1, 2);
        dup[1] = dup[0];
        vm.expectRevert(); // duplicate signer
        ref.publish(r, dup);
        bytes[] memory foreign = sign(r, 1, 9);
        vm.expectRevert(); // unregistered signer
        ref.publish(r, foreign);
        ref.publish(r, sign(r, 1, 2));
        (uint192 v, uint64 t) = ref.consult();
        require(v == 1886 && t == t0, "latest");
        bytes[] memory again = sign(r, 1, 2);
        vm.expectRevert(); // replay
        ref.publish(r, again);
        vm.warp(t0 + 300);
        r = HsxSignedReference.Reference(1900, t0 + 300 - 121, 2);
        bytes[] memory stale = sign(r, 2, 3);
        vm.expectRevert();
        ref.publish(r, stale);
        r = HsxSignedReference.Reference(0, t0 + 300, 2);
        bytes[] memory zero = sign(r, 2, 3);
        vm.expectRevert();
        ref.publish(r, zero);
        r = HsxSignedReference.Reference(1900, t0 + 300, 2);
        ref.publish(r, sign(r, 2, 3));
        r = HsxSignedReference.Reference(1900, t0 + 301, 3); // not yet observed
        bytes[] memory future = sign(r, 2, 3);
        vm.expectRevert();
        ref.publish(r, future);
    }

    function testCombinedOracleUsesConservativePriceAndRejectsDeviation() public {
        pool.set(int56(149686) * 1800, false);
        ProtocolAccess access = new ProtocolAccess(address(this));
        HsxPriceOracle prices = new HsxPriceOracle(access, twap, IHsxTwap(address(ref)));
        vm.expectRevert(); // reference never published
        prices.price();
        uint64 t0 = 1795263000;
        HsxSignedReference.Reference memory r = HsxSignedReference.Reference(1950, t0, 1);
        ref.publish(r, sign(r, 1, 3));
        (uint192 p,) = prices.price();
        (uint192 t,) = twap.consult();
        require(p == t && p < 1950, "min of sources");
        vm.warp(t0 + 60);
        r = HsxSignedReference.Reference(2500, t0 + 60, 2);
        ref.publish(r, sign(r, 1, 3));
        vm.expectRevert(); // >10% apart
        prices.price();
        r = HsxSignedReference.Reference(1900, t0 + 61, 3);
        vm.warp(t0 + 61);
        ref.publish(r, sign(r, 1, 3));
        prices.price();
        vm.warp(t0 + 61 + 16 minutes);
        vm.expectRevert(); // stale reference
        prices.price();
    }
}
