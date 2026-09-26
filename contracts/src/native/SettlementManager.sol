// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ProtocolTypes as T} from "./ProtocolTypes.sol";
import {NativeBinaryMarket} from "./NativeBinaryMarket.sol";
import {IndexOracle} from "./IndexOracle.sol";
import {ProtocolAccess} from "./ProtocolAccess.sol";

contract SettlementManager is ReentrancyGuard {
    IndexOracle public immutable oracle;
    ProtocolAccess public immutable access;
    address payable public immutable treasury;
    uint256 public constant CHALLENGE_WINDOW = 1 hours;
    uint256 public constant CHALLENGE_BOND = 0.1 ether;

    struct Proposal {
        uint192 valueE8;
        uint64 proposedAt;
        uint8 result;
        bool challenged;
        address challenger;
        bytes32 evidenceHash;
    }

    mapping(address => Proposal) public proposals;
    mapping(address => uint256) public bondRefund;

    event Proposed(address indexed market, uint192 valueE8, uint8 result, uint64 proposedAt);
    event Challenged(address indexed market, address challenger, uint8 reason, bytes32 evidence);
    event Adjudicated(address indexed market, bool upheld, bytes32 report);
    event Finalized(address indexed market, uint8 result);

    constructor(IndexOracle o, ProtocolAccess a, address payable t) {
        require(t != address(0), "treasury");
        oracle = o;
        access = a;
        treasury = t;
    }

    function windowValue(bytes32 indexId, uint64 time, uint64 radius)
        public
        view
        returns (bool usable, uint192 value)
    {
        if (block.timestamp < time + radius || oracle.registry().incident(indexId)) return (false, 0);
        uint256 weighted;
        uint64 previousSequence;
        uint64 previousTime;
        uint192 previousValue;
        uint256 count;
        for (uint64 ts = time - radius; ts <= time + radius; ts += 300) {
            T.Observation memory o = oracle.at(indexId, ts);
            if (o.valueE8 == 0 || o.confidenceBps < 8500) {
                if (ts == time - radius || ts == time + radius) return (false, 0);
                continue;
            }
            if (o.sequence <= previousSequence) return (false, 0);
            if (count > 0) {
                if (ts - previousTime > radius) return (false, 0);
                weighted += uint256(previousValue) * (ts - previousTime);
            }
            previousSequence = o.sequence;
            previousTime = ts;
            previousValue = o.valueE8;
            count++;
        }
        return count >= 3 ? (true, uint192(weighted / (radius * 2))) : (false, uint192(0));
    }

    function compute(NativeBinaryMarket m) public view returns (uint192 value, uint8 result) {
        require(address(m.settlement()) == address(this), "foreign market");
        T.Definition memory d = m.definition();
        (bool ok, uint192 v) = windowValue(d.indexId, d.resolutionTime, 300);
        if (!ok) (ok, v) = windowValue(d.indexId, d.resolutionTime, 900);
        if (!ok) {
            require(block.timestamp >= d.resolutionTime + 1 days, "awaiting oracle");
            return (0, uint8(T.State.INVALID));
        }
        return (v, uint8(T.yes(d, v) ? T.State.RESOLVED_YES : T.State.RESOLVED_NO));
    }

    function propose(NativeBinaryMarket market) external {
        require(proposals[address(market)].proposedAt == 0, "proposed");
        (uint192 value, uint8 result) = compute(market);
        proposals[address(market)] = Proposal(value, uint64(block.timestamp), result, false, address(0), 0);
        market.setState(T.State.PROPOSED);
        emit Proposed(address(market), value, result, uint64(block.timestamp));
    }

    function challenge(NativeBinaryMarket market, uint8 reason, bytes32 evidence) external payable {
        Proposal storage p = proposals[address(market)];
        require(
            p.proposedAt > 0 && !p.challenged && block.timestamp < p.proposedAt + CHALLENGE_WINDOW
                && msg.value == CHALLENGE_BOND && reason < 5 && evidence != bytes32(0),
            "challenge"
        );
        p.challenged = true;
        p.challenger = msg.sender;
        p.evidenceHash = evidence;
        emit Challenged(address(market), msg.sender, reason, evidence);
    }

    function adjudicate(NativeBinaryMarket market, bool upheld, bytes32 report) external {
        require(access.hasRole(access.RESOLUTION_ROLE(), msg.sender) && report != bytes32(0), "role/report");
        Proposal storage p = proposals[address(market)];
        require(p.challenged, "no challenge");
        (uint192 value, uint8 result) = compute(market); // committee cannot choose a price
        p.valueE8 = value;
        p.result = result;
        p.challenged = false;
        p.proposedAt = uint64(block.timestamp);
        bondRefund[upheld ? p.challenger : treasury] += CHALLENGE_BOND;
        p.challenger = address(0);
        emit Adjudicated(address(market), upheld, report);
    }

    function withdrawBond() external nonReentrant {
        uint256 amount = bondRefund[msg.sender];
        require(amount > 0, "empty");
        bondRefund[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "refund");
    }

    function finalize(NativeBinaryMarket market) external {
        Proposal storage p = proposals[address(market)];
        require(
            p.proposedAt > 0 && !p.challenged && block.timestamp >= p.proposedAt + CHALLENGE_WINDOW, "challenge window"
        );
        (uint192 value, uint8 result) = compute(market);
        require(value == p.valueE8 && result == p.result, "re-proposal required");
        market.setState(T.State(result));
        emit Finalized(address(market), result);
    }

    function refresh(NativeBinaryMarket market) external {
        Proposal storage p = proposals[address(market)];
        require(p.proposedAt > 0 && !p.challenged && market.state() == T.State.PROPOSED, "proposal");
        (uint192 value, uint8 result) = compute(market);
        require(value != p.valueE8 || result != p.result, "unchanged");
        p.valueE8 = value;
        p.result = result;
        p.proposedAt = uint64(block.timestamp);
        emit Proposed(address(market), value, result, p.proposedAt);
    }
}
