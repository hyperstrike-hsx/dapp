// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {STRIKEToken} from "../src/native/STRIKEToken.sol";
import {StrikeMinter, IHSX} from "../src/native/StrikeMinter.sol";
import {HsxPriceOracle, IHsxTwap} from "../src/native/HsxPriceOracle.sol";
import {ProtocolAccess} from "../src/native/ProtocolAccess.sol";

interface VmMint {
    function deal(address, uint256) external;
    function warp(uint256) external;
    function expectRevert() external;
}

contract BurnableHSXMock is ERC20, ERC20Burnable {
    constructor() ERC20("Test HSX", "HSX") {}

    function mint(address a, uint256 v) external {
        _mint(a, v);
    }
}

contract IndependentPriceMock is IHsxTwap {
    uint192 public value = 1e8;
    uint64 public timestamp;

    constructor() {
        timestamp = uint64(block.timestamp);
    }

    function set(uint192 p, uint64 t) external {
        value = p;
        timestamp = t;
    }

    function consult() external view returns (uint192, uint64) {
        return (value, timestamp);
    }
}

contract StrikeMinterTest {
    VmMint vm = VmMint(address(uint160(uint256(keccak256("hevm cheat code")))));
    STRIKEToken strike;
    BurnableHSXMock hsx;
    ProtocolAccess access;
    IndependentPriceMock a;
    IndependentPriceMock b;
    StrikeMinter minter;

    function setUp() public {
        vm.warp(100000);
        vm.deal(address(this), 10000 ether);
        access = new ProtocolAccess(address(this));
        access.grantRole(access.PAUSER_ROLE(), address(this));
        strike = new STRIKEToken(address(this));
        hsx = new BurnableHSXMock();
        a = new IndependentPriceMock();
        b = new IndependentPriceMock();
        HsxPriceOracle prices = new HsxPriceOracle(access, a, b);
        minter = new StrikeMinter(strike, IHSX(address(hsx)), access, prices, payable(address(0x777)));
        strike.setMinter(address(minter));
        hsx.mint(address(this), 1e27);
        hsx.approve(address(minter), type(uint256).max);
    }

    function testMintActuallyReducesSupplyAndUsesIntegratedPrice() public {
        (uint256 burn, uint256 hype,) = minter.quote(1e18);
        require(burn > 20e18 && burn < 21e18, "integral");
        uint256 before_ = hsx.totalSupply();
        minter.mintStrike{value: hype}(1e18, burn, hype, uint64(block.timestamp + 60));
        require(hsx.totalSupply() == before_ - burn, "true burn");
        require(strike.totalSupply() == 1e18 && strike.balanceOf(address(this)) == 1e18, "capacity");
    }

    function testCurveChangesAreBoundedAndDelayed() public {
        StrikeMinter.Curve memory c = StrikeMinter.Curve(10000e18, 30e18, 100e18, 1e18, 3e18);
        vm.expectRevert();
        minter.scheduleCurve(c);
        access.grantRole(access.CONFIG_ROLE(), address(this));
        minter.scheduleCurve(c);
        vm.expectRevert();
        minter.activateCurve();
        vm.warp(100000 + 2 days);
        minter.activateCurve();
        a.set(1e8, uint64(block.timestamp));
        b.set(1e8, uint64(block.timestamp));
        (uint256 burn,uint256 hype,) = minter.quote(1e18);
        require(burn > 30e18 && hype > 1e18, "new integrated curve");
        c.target=1e18;
        vm.expectRevert();
        minter.scheduleCurve(c);
    }

    function testMaxCostDeadlineExactHypeAndPause() public {
        (uint256 burn, uint256 hype,) = minter.quote(1e18);
        vm.expectRevert();
        minter.mintStrike{value: hype}(1e18, burn - 1, hype, uint64(block.timestamp + 60));
        vm.expectRevert();
        minter.mintStrike{value: hype + 1}(1e18, burn, hype, uint64(block.timestamp + 60));
        vm.expectRevert();
        minter.mintStrike{value: hype}(1e18, burn, hype, uint64(block.timestamp - 1));
        access.pause(true, false, false);
        vm.expectRevert();
        minter.mintStrike{value: hype}(1e18, burn, hype, uint64(block.timestamp + 60));
        require(strike.totalSupply() == 0, "failed mint supply");
    }

    function testStaleAndDeviatingPriceAreRejected() public {
        b.set(2e8, uint64(block.timestamp));
        vm.expectRevert();
        minter.quote(1e18);
        b.set(1e8, uint64(block.timestamp));
        vm.warp(101000);
        vm.expectRevert();
        minter.quote(1e18);
    }

    function testFuzzCurveSplittingAndCap(uint64 raw) public view {
        uint256 q = uint256(raw) % 10000e18 + 1e18;
        uint256 supply = 9999e18;
        uint256 total = minter.integrated(supply, q, 20e18, 100e18);
        uint256 half = q / 2;
        uint256 split =
            minter.integrated(supply, half, 20e18, 100e18) + minter.integrated(supply + half, q - half, 20e18, 100e18);
        require(split >= total && split - total <= 2, "split rounding");
        require(total <= 100 * q + 1, "marginal cap");
    }

    function testOnlyOneMinterAndSupplyMatchesMintMinusBurn() public {
        (uint256 burn, uint256 hype,) = minter.quote(3e18);
        minter.mintStrike{value: hype}(3e18, burn, hype, uint64(block.timestamp + 60));
        strike.burn(1e18);
        require(strike.totalSupply() == 2e18, "supply");
        vm.expectRevert();
        strike.mint(address(this), 1e18);
        vm.expectRevert();
        strike.setMinter(address(this));
    }
}
