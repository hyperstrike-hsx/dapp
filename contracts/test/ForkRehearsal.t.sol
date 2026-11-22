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
import {StrikeMinter, IHSX} from "../src/native/StrikeMinter.sol";
import {HsxPriceOracle, IHsxTwap} from "../src/native/HsxPriceOracle.sol";
import {HsxV3Twap, IV3PoolOracle} from "../src/native/HsxV3Twap.sol";
import {HsxSignedReference} from "../src/native/HsxSignedReference.sol";
import {NativeBinaryMarket} from "../src/native/NativeBinaryMarket.sol";
import {MarketFactory} from "../src/native/MarketFactory.sol";
import {SettlementManager} from "../src/native/SettlementManager.sol";
import {FeeVault} from "../src/native/FeeVault.sol";
import {MockOraclePx} from "./HsxPriceSources.t.sol";

interface VmFork {
    function envOr(string calldata, string calldata) external view returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function skip(bool) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function record() external;
    function accesses(address) external returns (bytes32[] memory, bytes32[] memory);
    function load(address, bytes32) external view returns (bytes32);
    function store(address, bytes32, bytes32) external;
    function expectRevert() external;
}

/**
 * Full lifecycle against real HyperEVM state: real USDC collateral, real HSX burn, real HSX/WHYPE pool.
 * Only the HyperCore oracle precompile is mocked (local forks do not emulate it).
 * Run: HS_FORK_RPC=https://rpc.hyperliquid.xyz/evm forge test --match-contract ForkRehearsal -vv
 */
contract ForkRehearsalTest {
    VmFork vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IERC20Metadata constant USDC = IERC20Metadata(0xb88339CB7199b77E23DB6E890353E22632Ba630f);
    IERC20Metadata constant HSX = IERC20Metadata(0xAb5DbC5A6070d066697d8e55471877eA4343eCe3);
    address constant WHYPE = 0x5555555555555555555555555555555555555555;
    address constant POOL = 0xA92AB5ed3041025B844233b109216c6C3c0bC63c;
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000807;
    bytes32 constant CS50 = keccak256("HS-CS50");
    bytes32 constant VERSION = keccak256("fork-rehearsal-v1");
    bytes32 constant ROOT = keccak256("fork-rehearsal-composition");
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address payable treasury = payable(address(0x7EA5));
    IndexOracle oracle;
    HsxSignedReference ref;
    ProtocolConfig config;
    STRIKEToken strike;
    StrikeMinter minter;
    FeeVault fees;
    SettlementManager settlement;
    MarketFactory factory;
    uint64 seq;
    uint64 clock;

    event Evidence(string what, uint256 value);

    function pair(bytes32 digest) private returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(2, digest);
        bool ordered = vm.addr(1) < vm.addr(2);
        sigs[ordered ? 0 : 1] = abi.encodePacked(r1, s1, v1);
        sigs[ordered ? 1 : 0] = abi.encodePacked(r2, s2, v2);
    }

    function publish(uint64 at_, uint192 value) private {
        clock = at_;
        vm.warp(at_);
        seq++;
        T.Observation memory o = T.Observation(CS50, VERSION, at_, value, 9600, ROOT, keccak256("sources"), seq);
        oracle.publish(o, pair(oracle.digest(o)));
    }

    /// Token-agnostic balance write: find the storage slot balanceOf reads and overwrite it.
    function give(IERC20Metadata token, address to, uint256 amount) private {
        vm.record();
        token.balanceOf(to);
        (bytes32[] memory reads,) = vm.accesses(address(token));
        for (uint256 i; i < reads.length; i++) {
            bytes32 prior = vm.load(address(token), reads[i]);
            vm.store(address(token), reads[i], bytes32(amount));
            // Low-level read: overwriting a proxy's implementation slot makes balanceOf revert/return nothing.
            (bool ok, bytes memory out) = address(token).staticcall(abi.encodeCall(token.balanceOf, (to)));
            if (ok && out.length == 32 && abi.decode(out, (uint256)) == amount) return;
            vm.store(address(token), reads[i], prior);
        }
        revert("balance slot not found");
    }

    function solvent(NativeBinaryMarket m) private view {
        require(
            USDC.balanceOf(address(m)) >= m.lockedCollateral() && m.lockedCollateral() >= m.liability(), "insolvent"
        );
    }

    function deploy() private {
        ProtocolAccess access = new ProtocolAccess(address(this));
        IndexRegistry registry = new IndexRegistry(
            access, [VERSION, VERSION, VERSION, VERSION, VERSION], [ROOT, ROOT, ROOT, ROOT, ROOT], keccak256("HRP")
        );
        OracleSignerRegistry signers = new OracleSignerRegistry(access, [vm.addr(1), vm.addr(2), vm.addr(3)]);
        oracle = new IndexOracle(registry, signers);
        config = new ProtocolConfig(USDC, oracle, 10000e6);
        strike = new STRIKEToken(address(this));
        HsxV3Twap twap = new HsxV3Twap(IV3PoolOracle(POOL), address(HSX), WHYPE, 159, 1e4);
        ref = new HsxSignedReference(signers);
        HsxPriceOracle prices = new HsxPriceOracle(access, twap, IHsxTwap(address(ref)));
        minter = new StrikeMinter(strike, IHSX(address(HSX)), access, prices, treasury);
        strike.setMinter(address(minter));
        fees = new FeeVault(USDC, treasury);
        settlement = new SettlementManager(oracle, access, treasury);
        factory = new MarketFactory(access, config, strike, settlement, fees, address(new NativeBinaryMarket()));
        // Signed reference tracks the real pool TWAP (+1%: the cross-check tolerates 10%).
        (uint192 poolUsdE8,) = twap.consult();
        emit Evidence("HSX pool TWAP usdE8", poolUsdE8);
        HsxSignedReference.Reference memory r = HsxSignedReference.Reference(poolUsdE8 * 101 / 100, clock, 1);
        ref.publish(r, pair(ref.digest(r)));
    }

    function mintCapacity() private {
        (uint256 hsxIn, uint256 hypeIn,) = minter.quote(2e18);
        emit Evidence("HSX burned for 2 STRIKE (wei)", hsxIn);
        emit Evidence("HYPE paid for 2 STRIKE (wei)", hypeIn);
        give(HSX, alice, hsxIn);
        vm.deal(alice, hypeIn);
        uint256 supply = HSX.totalSupply();
        vm.startPrank(alice);
        HSX.approve(address(minter), hsxIn);
        minter.mintStrike{value: hypeIn}(2e18, hsxIn, hypeIn, clock + 60);
        vm.stopPrank();
        // Launch gate evidence: the deployed HSX burnFrom is a true supply burn.
        require(HSX.totalSupply() == supply - hsxIn, "REAL HSX burnFrom IS NOT A TRUE BURN");
        require(HSX.balanceOf(alice) == 0 && strike.balanceOf(alice) == 2e18, "capacity");
        require(treasury.balance == hypeIn, "mint cost to treasury");
    }

    function testFullLifecycleOnHyperEvmFork() public {
        string memory rpc = vm.envOr("HS_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 999, "HyperEVM mainnet fork expected");
        require(USDC.decimals() == 6 && HSX.decimals() == 18, "token decimals");
        vm.etch(PRECOMPILE, address(new MockOraclePx()).code);
        MockOraclePx(PRECOMPILE).set(597120); // HYPE $59.712
        clock = uint64((block.timestamp / 300 + 1) * 300);
        vm.warp(clock);
        deploy();
        publish(clock, 1000e8);
        mintCapacity();

        give(USDC, alice, 2000e6);
        give(USDC, bob, 1000e6);
        uint64 expiry = config.expiry(T.Expiry.DAILY, clock);
        T.Definition memory level =
            T.Definition(T.Template.LEVEL, CS50, T.Direction.UP, 1000e8, 0, 0, expiry - 900, expiry, config.SETTLEMENT_POLICY());
        T.Definition memory move = T.Definition(
            T.Template.MOVE, CS50, T.Direction.UP, 250000000, clock, 1000e8, expiry - 900, expiry, config.SETTLEMENT_POLICY()
        );
        vm.startPrank(alice);
        strike.approve(address(factory), 2e18);
        USDC.approve(address(factory), 2000e6);
        NativeBinaryMarket a = NativeBinaryMarket(factory.create(level, T.Expiry.DAILY, 1000e6));
        NativeBinaryMarket b = NativeBinaryMarket(factory.create(move, T.Expiry.DAILY, 1000e6));
        vm.stopPrank();
        require(strike.totalSupply() == 0 && USDC.balanceOf(alice) == 0, "burn + seed");

        vm.startPrank(bob);
        USDC.approve(address(a), type(uint256).max);
        USDC.approve(address(b), type(uint256).max);
        uint256 yes = a.buy(0, 200e6, 1, clock + 60);
        uint256 no = b.buy(1, 100e6, 1, clock + 60);
        a.sell(0, yes / 2, 1, clock + 60);
        b.buy(0, 50e6, 1, clock + 60);
        vm.stopPrank();
        solvent(a);
        solvent(b);
        require(fees.totalAccrued() > 0 && USDC.balanceOf(address(fees)) == fees.totalAccrued(), "fees segregated");

        // Settlement window: +3% over the creation reference. LEVEL UP 1000 -> YES, MOVE UP 2.5% -> YES.
        publish(expiry - 300, 1030e8);
        vm.startPrank(bob);
        vm.expectRevert(); // trading locked
        a.buy(0, 1e6, 1, expiry);
        vm.stopPrank();
        publish(expiry, 1030e8);
        publish(expiry + 300, 1030e8);
        vm.warp(block.timestamp + 240); // the oracle publication window must have closed
        settlement.propose(a);
        settlement.propose(b);
        vm.expectRevert();
        settlement.finalize(a);
        vm.warp(block.timestamp + 1 hours);
        settlement.finalize(a);
        settlement.finalize(b);
        require(a.state() == T.State.RESOLVED_YES && b.state() == T.State.RESOLVED_YES, "resolution");
        solvent(a);
        solvent(b);

        uint256 bobBefore = USDC.balanceOf(bob);
        vm.startPrank(bob);
        uint256 paidA = a.redeem();
        uint256 paidB = b.redeem();
        vm.stopPrank();
        require(paidA == yes - yes / 2 && paidB > 0 && paidB < no, "YES pays 1:1, NO pays nothing");
        require(USDC.balanceOf(bob) == bobBefore + paidA + paidB, "redeemed USDC");
        vm.startPrank(alice);
        a.redeemPool();
        b.redeemPool();
        fees.claim();
        vm.stopPrank();
        vm.prank(treasury);
        fees.claim();
        a.sweepDust();
        b.sweepDust();
        require(USDC.balanceOf(address(a)) == 0 && USDC.balanceOf(address(b)) == 0, "markets drained exactly");
        require(USDC.balanceOf(address(fees)) == 0 && fees.totalAccrued() == 0, "fees fully claimed");
        // Conservation: every USDC that entered is with alice, bob or the treasury.
        require(USDC.balanceOf(alice) + USDC.balanceOf(bob) + USDC.balanceOf(treasury) == 3000e6, "conservation");
        emit Evidence("creator final USDC", USDC.balanceOf(alice));
        emit Evidence("trader final USDC", USDC.balanceOf(bob));
        emit Evidence("treasury fee USDC", USDC.balanceOf(treasury));
    }
}
