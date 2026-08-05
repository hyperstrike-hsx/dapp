// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HSXBurnGate} from "../src/HSXBurnGate.sol";

contract MockHSX {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function burnFrom(address account, uint256 amount) external {
        uint256 allowed = allowance[account][msg.sender];
        require(allowed >= amount, "allowance");
        require(balanceOf[account] >= amount, "balance");
        allowance[account][msg.sender] = allowed - amount;
        balanceOf[account] -= amount;
        totalSupply -= amount;
    }
}

contract GateActor {
    function approve(MockHSX token, HSXBurnGate gate, uint256 amount) external {
        token.approve(address(gate), amount);
    }

    function issue(HSXBurnGate gate, bytes32 specHash) external {
        gate.burnToIssue(specHash);
    }

    function participate(HSXBurnGate gate, uint64 outcomeId, bytes32 orderId, uint256 orderValueE18) external {
        gate.burnToParticipate(outcomeId, orderId, orderValueE18);
    }

    function bind(HSXBurnGate gate, bytes32 specHash, uint64 outcomeId) external {
        gate.bindOutcome(specHash, outcomeId);
    }
}

contract HSXBurnGateTest {
    MockHSX internal token;
    HSXBurnGate internal gate;
    GateActor internal alice;
    GateActor internal bob;

    uint256 internal constant ISSUE_BURN = 1_000e18;
    uint256 internal constant ORDER_VALUE = 25e18;
    uint256 internal constant PARTICIPATION_BURN = ORDER_VALUE / 100;
    bytes32 internal constant SPEC = keccak256("dragon-lore-ft-2026-08-01");
    bytes32 internal constant ORDER = keccak256("bob-dragon-lore-yes-40-contracts");

    function setUp() public {
        token = new MockHSX();
        gate = new HSXBurnGate(address(token), address(this), ISSUE_BURN);
        alice = new GateActor();
        bob = new GateActor();

        token.mint(address(alice), 10_000e18);
        token.mint(address(bob), 10_000e18);
        alice.approve(token, gate, type(uint256).max);
        bob.approve(token, gate, type(uint256).max);
    }

    function testBurnToIssueReducesSupplyAndRecordsIssuer() public {
        uint256 supplyBefore = token.totalSupply();
        alice.issue(gate, SPEC);

        require(gate.issuedBy(SPEC) == address(alice), "issuer");
        require(token.totalSupply() == supplyBefore - ISSUE_BURN, "supply");
        require(gate.totalIssuanceBurned() == ISSUE_BURN, "issuance total");
    }

    function testCannotIssueSameSpecTwice() public {
        alice.issue(gate, SPEC);
        (bool ok,) = address(bob).call(abi.encodeCall(GateActor.issue, (gate, SPEC)));
        require(!ok, "duplicate issue accepted");
    }

    function testOwnerBindsAndUserBurnsOnePercentPerOrder() public {
        alice.issue(gate, SPEC);
        gate.bindOutcome(SPEC, 172);
        uint256 supplyBefore = token.totalSupply();
        bob.participate(gate, 172, ORDER, ORDER_VALUE);

        require(gate.participationBurnedBy(ORDER) == address(bob), "participation");
        require(gate.participationBurnCount(address(bob), 172) == 1, "burn count");
        require(token.totalSupply() == supplyBefore - PARTICIPATION_BURN, "supply");
        require(gate.totalParticipationBurned() == PARTICIPATION_BURN, "participation total");

        (bool ok,) = address(bob).call(abi.encodeCall(GateActor.participate, (gate, 172, ORDER, ORDER_VALUE)));
        require(!ok, "duplicate order burn accepted");

        bytes32 secondOrder = keccak256("bob-dragon-lore-no-10-contracts");
        bob.participate(gate, 172, secondOrder, 10e18);
        require(gate.participationBurnCount(address(bob), 172) == 2, "second order burn");
    }

    function testCannotParticipateBeforeBinding() public {
        (bool ok,) = address(bob).call(abi.encodeCall(GateActor.participate, (gate, 172, ORDER, ORDER_VALUE)));
        require(!ok, "unbound participation accepted");
    }

    function testOnlyOwnerCanBind() public {
        alice.issue(gate, SPEC);
        (bool ok,) = address(alice).call(abi.encodeCall(GateActor.bind, (gate, SPEC, 172)));
        require(!ok, "non-owner bound outcome");
    }
}
