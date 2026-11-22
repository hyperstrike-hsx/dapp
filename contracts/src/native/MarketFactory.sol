// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {STRIKEToken} from "./STRIKEToken.sol";
import {ProtocolTypes as T} from "./ProtocolTypes.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {ProtocolAccess} from "./ProtocolAccess.sol";
import {NativeBinaryMarket} from "./NativeBinaryMarket.sol";
import {SettlementManager} from "./SettlementManager.sol";
import {FeeVault} from "./FeeVault.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract MarketFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ProtocolAccess public immutable access;
    ProtocolConfig public immutable config;
    STRIKEToken public immutable strike;
    SettlementManager public immutable settlement;
    FeeVault public immutable fees;
    address public immutable marketImplementation;
    mapping(bytes32 => address) public markets;

    event MarketCreated(
        bytes32 indexed key,
        address indexed market,
        address indexed creator,
        bytes32 indexId,
        uint64 resolutionTime,
        uint256 seedLiquidity
    );

    constructor(ProtocolAccess a, ProtocolConfig c, STRIKEToken s, SettlementManager sm, FeeVault f, address impl) {
        // The implementation is permanently un-initializable (its factory slot is burned in its constructor).
        require(impl.code.length > 0 && NativeBinaryMarket(impl).factory() == address(1), "implementation");
        marketImplementation = impl;
        access = a;
        config = c;
        strike = s;
        settlement = sm;
        fees = f;
    }

    function create(T.Definition calldata d, T.Expiry slot, uint256 seedLiquidity)
        external
        nonReentrant
        returns (address market)
    {
        require(!access.creationPaused(), "creation paused");
        config.validate(d, slot);
        bytes32 key = T.key(d);
        require(markets[key] == address(0), "duplicate");
        require(
            seedLiquidity >= 100 * 10 ** config.collateralDecimals() && seedLiquidity <= config.pilotCap() / 4,
            "seed bounds"
        );
        strike.burnFrom(msg.sender, config.strikeCost());
        market = Clones.cloneDeterministic(marketImplementation, key);
        NativeBinaryMarket(market).initialize(d, access, config, fees, address(settlement), msg.sender);
        markets[key] = market;
        IERC20(address(config.collateral())).safeTransferFrom(msg.sender, market, seedLiquidity);
        NativeBinaryMarket(market).seed(seedLiquidity);
        emit MarketCreated(key, market, msg.sender, d.indexId, d.resolutionTime, seedLiquidity);
    }
}
