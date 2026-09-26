// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {STRIKEToken} from "./STRIKEToken.sol";
import {ProtocolAccess} from "./ProtocolAccess.sol";
import {HsxPriceOracle} from "./HsxPriceOracle.sol";

interface IHSX {
    function burnFrom(address, uint256) external;
    function totalSupply() external view returns (uint256);
}

contract StrikeMinter is ReentrancyGuard {
    STRIKEToken public immutable strike;
    IHSX public immutable hsx;
    ProtocolAccess public immutable access;
    HsxPriceOracle public immutable priceOracle;
    address payable public immutable treasury;
    uint256 public constant TARGET = 10000e18;
    struct Curve {uint256 target;uint256 minUsd;uint256 maxUsd;uint256 minHype;uint256 maxHype;}
    Curve public curve=Curve(TARGET,20e18,100e18,0.5e18,3e18);
    Curve public pendingCurve;
    uint64 public curveActivation;
    event CurveScheduled(bytes32 indexed parametersHash,uint64 activatesAt);
    event CurveActivated(bytes32 indexed parametersHash);

    event Minted(address indexed account, uint256 strikeAmount, uint256 hsxBurned, uint256 hypePaid);

    constructor(STRIKEToken s, IHSX h, ProtocolAccess a, HsxPriceOracle p, address payable t) {
        require(address(h).code.length > 0 && t != address(0), "config");
        strike = s;
        hsx = h;
        access = a;
        priceOracle = p;
        treasury = t;
    }

    function integrated(uint256 supply, uint256 amount, uint256 minimum, uint256 maximum)
        public
        pure
        returns (uint256)
    {
        return integral(supply,amount,minimum,maximum,TARGET);
    }
    function integral(uint256 supply,uint256 amount,uint256 minimum,uint256 maximum,uint256 target) private pure returns(uint256) {
        require(amount > 0 && amount <= 1e24 && supply <= 1e30, "quantity bound");
        uint256 end = supply + amount;
        uint256 lo = Math.min(supply, target);
        uint256 hi = Math.min(end, target);
        // x^3 fits uint256 under the bounded one-million STRIKE target.
        uint256 cubic = hi * hi * hi - lo * lo * lo;
        uint256 den = 3 * target * target;
        uint256 variableE18 = Math.mulDiv(maximum - minimum, cubic, den, Math.Rounding.Ceil);
        uint256 baseE18 = minimum * (hi - lo);
        return Math.ceilDiv(baseE18 + variableE18, 1e18)
            + Math.mulDiv(maximum, end - hi - (supply - lo), 1e18, Math.Rounding.Ceil);
    }
    function scheduleCurve(Curve calldata next) external {
        require(access.hasRole(access.CONFIG_ROLE(),msg.sender),"config role");
        require(next.target>=100e18&&next.target<=1000000e18&&next.minUsd>=1e18&&next.maxUsd>=next.minUsd&&next.maxUsd<=1000e18&&next.minHype>0&&next.maxHype>=next.minHype&&next.maxHype<=10e18,"curve bounds");
        pendingCurve=next;curveActivation=uint64(block.timestamp+2 days);emit CurveScheduled(keccak256(abi.encode(next)),curveActivation);
    }
    function activateCurve() external {
        require(curveActivation>0&&block.timestamp>=curveActivation,"curve timelock");curve=pendingCurve;delete pendingCurve;curveActivation=0;emit CurveActivated(keccak256(abi.encode(curve)));
    }

    function quote(uint256 amount) public view returns (uint256 hsxIn, uint256 hypeIn, uint64 observedAt) {
        (uint192 price, uint64 time) = priceOracle.price();
        uint256 supply = strike.totalSupply();
        Curve memory c=curve;
        hsxIn = Math.mulDiv(integral(supply, amount, c.minUsd, c.maxUsd,c.target), 1e8, price, Math.Rounding.Ceil);
        hypeIn = integral(supply, amount, c.minHype, c.maxHype,c.target);
        observedAt = time;
    }

    function mintStrike(uint256 amount, uint256 maxHsxIn, uint256 maxHypeIn, uint64 deadline)
        external
        payable
        nonReentrant
    {
        require(!access.mintPaused() && block.timestamp <= deadline, "paused/expired");
        (uint256 hsxIn, uint256 hypeIn,) = quote(amount);
        require(hsxIn <= maxHsxIn && hypeIn <= maxHypeIn && msg.value == hypeIn, "cost limit/exact value");
        uint256 beforeSupply = hsx.totalSupply();
        hsx.burnFrom(msg.sender, hsxIn);
        require(hsx.totalSupply() + hsxIn == beforeSupply, "not a true burn");
        strike.mint(msg.sender, amount);
        (bool ok,) = treasury.call{value: hypeIn}("");
        require(ok, "treasury");
        emit Minted(msg.sender, amount, hsxIn, hypeIn);
    }
}
