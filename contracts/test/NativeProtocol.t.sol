// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ProtocolTypes as T} from "../src/native/ProtocolTypes.sol";
import {ProtocolAccess} from "../src/native/ProtocolAccess.sol";
import {IndexRegistry} from "../src/native/IndexRegistry.sol";
import {OracleSignerRegistry} from "../src/native/OracleSignerRegistry.sol";
import {IndexOracle} from "../src/native/IndexOracle.sol";
import {ProtocolConfig} from "../src/native/ProtocolConfig.sol";
import {STRIKEToken} from "../src/native/STRIKEToken.sol";
import {StrikeMinter, IHSX} from "../src/native/StrikeMinter.sol";
import {HsxPriceOracle, IHsxTwap} from "../src/native/HsxPriceOracle.sol";
import {NativeBinaryMarket} from "../src/native/NativeBinaryMarket.sol";
import {MarketFactory} from "../src/native/MarketFactory.sol";
import {SettlementManager} from "../src/native/SettlementManager.sol";
import {FeeVault} from "../src/native/FeeVault.sol";

interface VmNative {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function expectRevert() external;
}

contract PilotCollateral is ERC20 {
    constructor() ERC20("Pilot USD", "PUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address a, uint256 v) external {
        _mint(a, v);
    }
}

contract NativeProtocolTest {
    VmNative vm = VmNative(address(uint160(uint256(keccak256("hevm cheat code")))));
    ProtocolAccess access;
    IndexRegistry registry;
    OracleSignerRegistry signers;
    IndexOracle oracle;
    ProtocolConfig config;
    STRIKEToken strike;
    PilotCollateral usd;
    FeeVault fees;
    SettlementManager settlement;
    MarketFactory factory;
    address alice = address(0xA11CE);
    address treasury = address(0x777);
    bytes32 indexId = keccak256("HS-CS50");
    bytes32 versionId = keccak256("v1");
    uint64 seq;

    function setUp() public {
        vm.warp(1790341200);
        access = new ProtocolAccess(address(this));
        access.grantRole(access.ORACLE_ADMIN_ROLE(), address(this));
        access.grantRole(access.PAUSER_ROLE(), address(this));
        access.grantRole(access.RESOLUTION_ROLE(), address(this));
        registry = new IndexRegistry(access);
        registry.schedule(
            indexId,
            IndexRegistry.Version(
                versionId, uint64(block.timestamp + 7 days), keccak256("methodology"), keccak256("composition")
            )
        );
        vm.warp(block.timestamp + 7 days);
        address[3] memory addresses = [vm.addr(1), vm.addr(2), vm.addr(3)];
        signers = new OracleSignerRegistry(access, addresses);
        oracle = new IndexOracle(registry, signers);
        publish(uint64(block.timestamp), 1000e8, 9800);
        usd = new PilotCollateral();
        config = new ProtocolConfig(IERC20Metadata(address(usd)), oracle, 100000e6);
        strike = new STRIKEToken(address(this));
        strike.setMinter(address(this));
        strike.mint(alice, 100e18);
        fees = new FeeVault(usd, treasury);
        settlement = new SettlementManager(oracle, access, payable(treasury));
        factory = new MarketFactory(access, config, strike, settlement, fees);
        usd.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        strike.approve(address(factory), type(uint256).max);
        usd.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    function signatures(T.Observation memory o) private returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        bytes32 digest = oracle.digest(o);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(2, digest);
        bool ordered = vm.addr(1) < vm.addr(2);
        sigs[ordered ? 0 : 1] = abi.encodePacked(r1, s1, v1);
        sigs[ordered ? 1 : 0] = abi.encodePacked(r2, s2, v2);
    }

    function publish(uint64 at_, uint192 value, uint32 confidence) private {
        vm.warp(at_);
        seq++;
        T.Observation memory o = T.Observation(
            indexId, versionId, at_, value, confidence, keccak256("composition"), keccak256("sources"), seq
        );
        oracle.publish(o, signatures(o));
    }

    function definition() private view returns (T.Definition memory) {
        uint64 t = config.expiry(T.Expiry.DAILY, block.timestamp);
        return T.Definition(
            T.Template.LEVEL, indexId, T.Direction.UP, 1000e8, 0, 0, t - 300, t, config.SETTLEMENT_POLICY()
        );
    }

    function createMarket() private returns (NativeBinaryMarket m) {
        T.Definition memory d = definition();
        vm.prank(alice);
        m = NativeBinaryMarket(factory.create(d, T.Expiry.DAILY, 1000e6));
        vm.prank(alice);
        usd.approve(address(m), type(uint256).max);
    }

    function resolve(NativeBinaryMarket m, uint192 price) private {
        T.Definition memory d = m.definition();
        publish(d.resolutionTime - 300, price, 9500);
        publish(d.resolutionTime, price, 9500);
        publish(d.resolutionTime + 300, price, 9500);
        settlement.propose(m);
        vm.warp(block.timestamp + 1 hours);
        settlement.finalize(m);
    }

    function testExactCreationBurnAndUniqueness() public {
        uint256 supply = strike.totalSupply();
        NativeBinaryMarket m = createMarket();
        require(strike.totalSupply() == supply - 1e18, "burn");
        require(factory.markets(m.marketKey()) == address(m), "registry");
        T.Definition memory d = definition();
        vm.startPrank(alice);
        vm.expectRevert();
        factory.create(d, T.Expiry.DAILY, 1000e6);
        vm.stopPrank();
        require(strike.totalSupply() == supply - 1e18, "reverted burn");
    }

    function testRevertedSeedRollsBackBurn() public {
        T.Definition memory d = definition();
        uint256 supply = strike.totalSupply();
        vm.startPrank(alice);
        usd.approve(address(factory), 0);
        vm.expectRevert();
        factory.create(d, T.Expiry.DAILY, 1000e6);
        vm.stopPrank();
        require(strike.totalSupply() == supply, "atomic burn");
        require(factory.markets(T.key(d)) == address(0), "atomic registry");
    }

    function testRejectsConstituentAndArbitraryStrike() public {
        T.Definition memory d = definition();
        d.indexId = keccak256("AWP Dragon Lore");
        vm.startPrank(alice);
        vm.expectRevert();
        factory.create(d, T.Expiry.DAILY, 1000e6);
        d.indexId = indexId;
        d.thresholdE8 = 100012345678;
        vm.expectRevert();
        factory.create(d, T.Expiry.DAILY, 1000e6);
        vm.stopPrank();
    }

    function testNoTradeAfterLockAndPauseDoesNotPreventRedemption() public {
        NativeBinaryMarket m = createMarket();
        vm.prank(alice);
        m.buy(0, 100e6, 1, uint64(block.timestamp + 60));
        T.Definition memory d = m.definition();
        vm.warp(d.tradeCloseTime);
        vm.startPrank(alice);
        vm.expectRevert();
        m.buy(0, 1e6, 1, uint64(block.timestamp + 60));
        vm.stopPrank();
        resolve(m, 1100e8);
        access.pause(true, true, true);
        uint256 balance = usd.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = m.redeem();
        require(usd.balanceOf(alice) == balance + payout, "payout");
        vm.startPrank(alice);
        vm.expectRevert();
        m.redeem();
        vm.stopPrank();
        vm.expectRevert();
        settlement.finalize(m);
    }

    function testInvalidRedemptionPreservesCompleteSetBacking() public {
        NativeBinaryMarket m = createMarket();
        vm.startPrank(alice);
        m.buy(0, 100e6, 1, uint64(block.timestamp + 60));
        m.buy(1, 75e6, 1, uint64(block.timestamp + 60));
        vm.stopPrank();
        T.Definition memory d = m.definition();
        vm.warp(d.resolutionTime + 1 days);
        settlement.propose(m);
        vm.warp(block.timestamp + 1 hours);
        settlement.finalize(m);
        require(m.state() == T.State.INVALID, "invalid");
        uint256 expected = (m.balanceOf(alice, 0) + m.balanceOf(alice, 1)) / 2;
        vm.prank(alice);
        require(m.redeem() == expected, "half payout");
        vm.prank(alice);
        m.redeemPool();
        require(m.totalClaims(0) == 0 && m.totalClaims(1) == 0, "liability zero");
        m.sweepDust();
        require(usd.balanceOf(address(m)) == 0, "dust");
    }

    function testFeesCannotTouchBackingAndClaimsArePullBased() public {
        NativeBinaryMarket m = createMarket();
        vm.prank(alice);
        m.buy(0, 100e6, 1, uint64(block.timestamp + 60));
        require(fees.accrued(alice) == 60000, "creator 30%");
        require(fees.accrued(treasury) == 140000, "protocol 70%");
        uint256 backing = usd.balanceOf(address(m));
        vm.prank(alice);
        fees.claim();
        require(usd.balanceOf(address(m)) == backing, "backing separated");
        vm.startPrank(alice);
        vm.expectRevert();
        fees.claim();
        vm.stopPrank();
    }

    function testFuzzBuySellSolvency(uint64 raw, uint8 sideRaw) public {
        NativeBinaryMarket m = createMarket();
        uint256 amount = uint256(raw) % 200e6 + 2;
        uint8 side = sideRaw % 2;
        uint256 beforeBalance = usd.balanceOf(alice);
        vm.startPrank(alice);
        uint256 tokens = m.buy(side, amount, 1, uint64(block.timestamp + 60));
        require(m.reserve(0) * m.reserve(1) >= 1000e6 * 1000e6, "k decreases");
        if (tokens > 5) m.sell(side, tokens, 1, uint64(block.timestamp + 60));
        vm.stopPrank();
        require(usd.balanceOf(alice) <= beforeBalance, "printed collateral");
        require(usd.balanceOf(address(m)) >= m.liability(), "solvency");
    }

    function testOracleRejectsReplayDuplicateSignerAndUnsafeCreation() public {
        T.Observation memory o = oracle.latest(indexId);
        vm.expectRevert();
        oracle.publish(o, new bytes[](0));
        o.observedAt += 300;
        o.sequence++;
        vm.warp(o.observedAt);
        bytes[] memory sigs = signatures(o);
        sigs[1] = sigs[0];
        vm.expectRevert();
        oracle.publish(o, sigs);
        publish(o.observedAt, 1000e8, 7400);
        T.Definition memory d = definition();
        vm.startPrank(alice);
        vm.expectRevert();
        factory.create(d, T.Expiry.DAILY, 1000e6);
        vm.stopPrank();
    }

    function testEarlyFinalityAndChallengeBond() public {
        NativeBinaryMarket m = createMarket();
        vm.expectRevert();
        settlement.propose(m);
        T.Definition memory d = m.definition();
        publish(d.resolutionTime - 300, 1100e8, 9500);
        publish(d.resolutionTime, 1100e8, 9500);
        publish(d.resolutionTime + 300, 1100e8, 9500);
        settlement.propose(m);
        vm.expectRevert();
        settlement.finalize(m);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        settlement.challenge{value: 0.1 ether}(m, 0, keccak256("evidence"));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert();
        settlement.finalize(m);
        settlement.adjudicate(m, false, keccak256("report"));
        vm.warp(d.resolutionTime + 300 + 2 hours);
        settlement.finalize(m);
        require(m.state() == T.State.RESOLVED_YES, "final");
        require(settlement.bondRefund(treasury) == 0.1 ether, "slashed bond");
    }

    function testFallbackCanBridgeMissingPrimaryObservation() public {
        NativeBinaryMarket m = createMarket();
        T.Definition memory d = m.definition();
        publish(d.resolutionTime - 900, 1000e8, 9500);
        publish(d.resolutionTime, 1100e8, 9500);
        publish(d.resolutionTime + 900, 1200e8, 9500);
        (uint192 value, uint8 result) = settlement.compute(m);
        require(value == 1050e8 && result == uint8(T.State.RESOLVED_YES), "fallback TWAP");
    }

    function testCanonicalCalendar() public view {
        require(config.expiry(T.Expiry.WEEKLY, 1790344500) % 1 days == 16 hours, "UTC");
        require(config.expiry(T.Expiry.MONTHLY, 1832976000) == 1835452800, "leap month");
    }

    function testOracleRejectsUnscheduledCompositionEvenWithQuorum() public {
        uint64 next = uint64(block.timestamp + 300);
        vm.warp(next);
        T.Observation memory o=T.Observation(indexId,versionId,next,1000e8,9800,keccak256("unauthorized basket"),keccak256("sources"),seq+1);
        bytes[] memory signed=signatures(o);
        vm.expectRevert();
        oracle.publish(o,signed);
    }
}
