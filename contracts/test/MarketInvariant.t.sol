// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ProtocolTypes as T} from "../src/native/ProtocolTypes.sol";
import {ProtocolAccess} from "../src/native/ProtocolAccess.sol";
import {IndexRegistry} from "../src/native/IndexRegistry.sol";
import {OracleSignerRegistry} from "../src/native/OracleSignerRegistry.sol";
import {IndexOracle} from "../src/native/IndexOracle.sol";
import {ProtocolConfig} from "../src/native/ProtocolConfig.sol";
import {STRIKEToken} from "../src/native/STRIKEToken.sol";
import {NativeBinaryMarket} from "../src/native/NativeBinaryMarket.sol";
import {MarketFactory} from "../src/native/MarketFactory.sol";
import {SettlementManager} from "../src/native/SettlementManager.sol";
import {FeeVault} from "../src/native/FeeVault.sol";
import {PilotCollateral, VmNative} from "./NativeProtocol.t.sol";

interface IResolver {
    function resolve(uint8 outcome) external;
}

/// Random buys/sells across actors, then one random resolution (YES/NO/INVALID) and random redemptions.
contract MarketHandler {
    VmNative vm = VmNative(address(uint160(uint256(keccak256("hevm cheat code")))));
    NativeBinaryMarket public market;
    PilotCollateral usd;
    FeeVault fees;
    IResolver resolver;
    address[4] public actors;
    address public creator;
    bool public resolved;
    uint256 public trades;
    uint256 public redemptions;
    uint256 public paidIn;
    uint256 public paidOut;

    constructor(NativeBinaryMarket m, PilotCollateral u, FeeVault f, address creator_) {
        (market, usd, fees, creator, resolver) = (m, u, f, creator_, IResolver(msg.sender));
        for (uint160 i; i < 4; i++) {
            actors[i] = address(0xAC70 + i);
            usd.mint(actors[i], 1_000_000e6);
            vm.prank(actors[i]);
            usd.approve(address(m), type(uint256).max);
        }
    }

    function buy(uint8 who, uint8 side, uint64 amount) external {
        if (resolved) return;
        address a = actors[who % 4];
        uint256 gross = uint256(amount) % 400e6 + 2;
        vm.prank(a);
        try market.buy(side % 2, gross, 1, type(uint64).max) {
            trades++;
            paidIn += gross;
        } catch {}
    }

    function sell(uint8 who, uint8 side, uint16 fractionBps) external {
        if (resolved) return;
        address a = actors[who % 4];
        uint256 tokens = market.balanceOf(a, side % 2) * (uint256(fractionBps) % 10000 + 1) / 10000;
        if (tokens == 0) return;
        vm.prank(a);
        try market.sell(side % 2, tokens, 1, type(uint64).max) returns (uint256 out) {
            trades++;
            paidOut += out;
        } catch {}
    }

    function resolve(uint8 outcome) external {
        if (resolved || trades < 3) return;
        resolved = true;
        resolver.resolve(outcome % 3);
    }

    function redeem(uint8 who) external {
        if (!resolved) return;
        address a = who % 5 == 4 ? creator : actors[who % 4];
        vm.prank(a);
        try market.redeem() returns (uint256 out) {
            redemptions++;
            paidOut += out;
        } catch {}
    }

    function redeemPool() external {
        if (!resolved) return;
        vm.prank(creator);
        try market.redeemPool() returns (uint256 out) {
            redemptions++;
            paidOut += out;
        } catch {}
    }

    function claimFees(uint8 who) external {
        vm.prank(who % 2 == 0 ? creator : fees.treasury());
        try fees.claim() {} catch {}
    }
}

contract MarketInvariantTest is IResolver {
    VmNative vm = VmNative(address(uint160(uint256(keccak256("hevm cheat code")))));
    ProtocolAccess access;
    IndexOracle oracle;
    ProtocolConfig config;
    PilotCollateral usd;
    FeeVault fees;
    SettlementManager settlement;
    NativeBinaryMarket market;
    MarketHandler handler;
    address alice = address(0xA11CE);
    bytes32 indexId = keccak256("HS-CS50");
    bytes32 v = keccak256("v1");
    bytes32 c = keccak256("composition");
    uint64 seq;
    uint64 resolution;

    function setUp() public {
        vm.warp(1790946000);
        access = new ProtocolAccess(address(this));
        IndexRegistry registry = new IndexRegistry(access, [v, v, v, v, v], [c, c, c, c, c], keccak256("m"));
        oracle = new IndexOracle(registry, new OracleSignerRegistry(access, [vm.addr(1), vm.addr(2), vm.addr(3)]));
        publish(1790946000, 1000e8);
        usd = new PilotCollateral();
        config = new ProtocolConfig(IERC20Metadata(address(usd)), oracle, 100000e6);
        STRIKEToken strike = new STRIKEToken(address(this));
        strike.setMinter(address(this));
        strike.mint(alice, 1e18);
        fees = new FeeVault(usd, address(0x777));
        settlement = new SettlementManager(oracle, access, payable(address(0x777)));
        MarketFactory factory = new MarketFactory(access, config, strike, settlement, fees, address(new NativeBinaryMarket()));
        usd.mint(alice, 1000e6);
        resolution = config.expiry(T.Expiry.DAILY, 1790946000);
        T.Definition memory d = T.Definition(
            T.Template.LEVEL,
            indexId,
            T.Direction.UP,
            1000e8,
            0,
            0,
            resolution - 900,
            resolution,
            config.SETTLEMENT_POLICY()
        );
        vm.startPrank(alice);
        strike.approve(address(factory), 1e18);
        usd.approve(address(factory), 1000e6);
        market = NativeBinaryMarket(factory.create(d, T.Expiry.DAILY, 1000e6));
        vm.stopPrank();
        handler = new MarketHandler(market, usd, fees, alice);
    }

    function publish(uint64 at_, uint192 value) private {
        vm.warp(at_);
        seq++;
        T.Observation memory o = T.Observation(indexId, v, at_, value, 9500, c, keccak256("sources"), seq);
        bytes[] memory sigs = new bytes[](2);
        bytes32 digest = oracle.digest(o);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(2, digest);
        bool ordered = vm.addr(1) < vm.addr(2);
        sigs[ordered ? 0 : 1] = abi.encodePacked(r1, s1, v1);
        sigs[ordered ? 1 : 0] = abi.encodePacked(r2, s2, v2);
        oracle.publish(o, sigs);
    }

    function resolve(uint8 outcome) external {
        require(msg.sender == address(handler), "handler");
        if (outcome == 2) {
            vm.warp(resolution + 1 days); // no oracle data: INVALID
            settlement.propose(market);
            vm.warp(resolution + 1 days + 1 hours);
        } else {
            uint192 price = outcome == 0 ? 1100e8 : 900e8;
            publish(resolution - 300, price);
            publish(resolution, price);
            publish(resolution + 300, price);
            vm.warp(block.timestamp + 240); // the oracle publication window must have closed
            settlement.propose(market);
            vm.warp(resolution + 300 + 1 hours);
        }
        settlement.finalize(market);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_collateralCoversLockedCoversLiability() public view {
        require(usd.balanceOf(address(market)) >= market.lockedCollateral(), "balance < locked");
        require(market.lockedCollateral() >= market.liability(), "locked < liability");
    }

    function invariant_feeVaultCoversAccruals() public view {
        require(usd.balanceOf(address(fees)) >= fees.totalAccrued(), "fee vault short");
        require(fees.totalAccrued() == fees.accrued(alice) + fees.accrued(address(0x777)), "accrual sum");
    }

    function invariant_claimsAreFullyAccounted() public view {
        for (uint8 side; side < 2; side++) {
            uint256 total = market.reserve(side) + market.balanceOf(alice, side);
            for (uint256 i; i < 4; i++) {
                total += market.balanceOf(handler.actors(i), side);
            }
            require(total == market.totalClaims(side), "claims != reserve + balances");
        }
        if (!handler.resolved()) {
            require(
                market.totalClaims(0) == market.lockedCollateral() && market.totalClaims(1) == market.lockedCollateral(),
                "complete sets"
            );
        }
    }

    function invariant_tradersNeverExtractMoreThanDeposited() public view {
        // Everything ever paid out to traders/creator is bounded by seed + trader deposits.
        require(handler.paidOut() <= handler.paidIn() + 1000e6, "printed collateral");
    }
}
