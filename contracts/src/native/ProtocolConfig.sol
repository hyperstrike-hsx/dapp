// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ProtocolTypes as T} from "./ProtocolTypes.sol";
import {IndexOracle} from "./IndexOracle.sol";

// Immutable launch policy. New policies/factories are versioned, never retroactive.
contract ProtocolConfig {
    bytes32 public constant SETTLEMENT_POLICY = keccak256("HS-TWAP-5M-15M-24H-V1");
    IERC20Metadata public immutable collateral;
    uint8 public immutable collateralDecimals;
    uint256 public immutable pilotCap;
    uint256 public constant feeBps = 20;
    uint256 public constant creatorShareBps = 3000;
    uint256 public constant strikeCost = 1e18;
    uint256 public constant maxPriceImpactBps = 2500;
    IndexOracle public immutable oracle;

    constructor(IERC20Metadata c, IndexOracle o, uint256 cap) {
        require(address(c).code.length > 0 && c.decimals() <= 18 && cap > 0 && cap <= 1e30, "collateral/cap");
        collateral = c;
        collateralDecimals = c.decimals();
        oracle = o;
        pilotCap = cap;
    }

    function expiry(T.Expiry slot, uint256 now_) public pure returns (uint64) {
        uint256 day = now_ / 1 days;
        uint256 candidate = day * 1 days + 16 hours;
        if (slot == T.Expiry.DAILY) {
            if (candidate <= now_ + 5 minutes) candidate += 1 days;
        } else if (slot == T.Expiry.WEEKLY) {
            candidate += ((5 + 7 - (day + 4) % 7) % 7) * 1 days;
            if (candidate <= now_ + 5 minutes) candidate += 7 days;
        } else {
            uint256 year = 1970;
            uint256 rest = day;
            while (true) {
                uint256 length = leap(year) ? 366 : 365;
                if (rest < length) break;
                rest -= length;
                year++;
            }
            uint256 month = 1;
            while (rest >= monthDays(year, month)) {
                rest -= monthDays(year, month);
                month++;
            }
            candidate += (monthDays(year, month) - rest - 1) * 1 days;
            if (candidate <= now_ + 5 minutes) {
                month++;
                if (month == 13) {
                    year++;
                    month = 1;
                }
                candidate += monthDays(year, month) * 1 days;
            }
        }
        return uint64(candidate);
    }

    function leap(uint256 y) private pure returns (bool) {
        return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    }

    function monthDays(uint256 y, uint256 m) private pure returns (uint256) {
        if (m == 2) return leap(y) ? 29 : 28;
        return m == 4 || m == 6 || m == 9 || m == 11 ? 30 : 31;
    }

    function validate(T.Definition calldata d, T.Expiry slot) external view {
        require(oracle.registry().canonical(d.indexId) && !oracle.registry().incident(d.indexId), "canonical index");
        T.Observation memory ref = oracle.latest(d.indexId);
        require(
            ref.observedAt <= block.timestamp && block.timestamp - ref.observedAt <= 300 && ref.confidenceBps >= 9000,
            "unsafe index"
        );
        require(
            d.settlementPolicyId == SETTLEMENT_POLICY && d.resolutionTime == expiry(slot, block.timestamp)
                && d.tradeCloseTime == d.resolutionTime - 300,
            "expiry/policy"
        );
        require(d.thresholdE8 > 0, "threshold");
        if (d.template == T.Template.LEVEL) {
            require(d.creationReferenceTime == 0 && d.creationReferenceValueE8 == 0, "level reference");
            uint256 magnitude = 1e8;
            while (magnitude * 10 <= ref.valueE8) magnitude *= 10;
            uint256 step = magnitude * (slot == T.Expiry.DAILY ? 100 : slot == T.Expiry.WEEKLY ? 250 : 500) / 10000;
            uint256 center = (uint256(ref.valueE8) + step / 2) / step * step;
            uint256 threshold = uint256(uint192(d.thresholdE8));
            require(
                threshold % step == 0 && threshold + 2 * step >= center && threshold <= center + 2 * step, "level grid"
            );
        } else {
            require(
                d.creationReferenceTime == ref.observedAt && d.creationReferenceValueE8 == ref.valueE8, "move reference"
            );
            int192 v = d.thresholdE8;
            bool valid = slot == T.Expiry.DAILY
                ? (v == 250000000 || v == 500000000)
                : slot == T.Expiry.WEEKLY
                    ? (v == 500000000 || v == 750000000 || v == 1000000000)
                    : (v == 1000000000 || v == 1500000000 || v == 2000000000);
            require(valid, "move grid");
        }
    }
}
