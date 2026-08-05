// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHSXBurnable {
    function burnFrom(address account, uint256 amount) external;
}

/// @notice Application-level burn receipts for HyperStrike's HIP-4 workflow.
/// @dev This contract cannot prevent a user from submitting an order directly to HyperCore.
contract HSXBurnGate {
    error AlreadyIssued(bytes32 specHash);
    error OrderAlreadyBurned(bytes32 orderId);
    error MarketAlreadyBound(uint64 outcomeId);
    error MarketNotBound(uint64 outcomeId);
    error NotOwner();
    error Reentrancy();
    error SpecAlreadyBound(bytes32 specHash);
    error SpecNotIssued(bytes32 specHash);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroSpecHash();

    IHSXBurnable public immutable hsx;
    address public immutable owner;
    uint256 public immutable issuanceBurnAmount;

    uint256 public totalBurned;
    uint256 public totalIssuanceBurned;
    uint256 public totalParticipationBurned;

    mapping(bytes32 specHash => address issuer) public issuedBy;
    mapping(bytes32 specHash => bool bound) public isSpecBound;
    mapping(uint64 outcomeId => bytes32 specHash) public outcomeSpec;
    mapping(uint64 outcomeId => bool bound) public isOutcomeBound;
    mapping(bytes32 orderId => address user) public participationBurnedBy;
    mapping(address user => mapping(uint64 outcomeId => uint256 count)) public participationBurnCount;

    uint256 private unlocked = 1;

    event IssuanceBurned(address indexed issuer, bytes32 indexed specHash, uint256 amount);
    event OutcomeBound(bytes32 indexed specHash, uint64 indexed outcomeId);
    event ParticipationBurned(address indexed user, uint64 indexed outcomeId, bytes32 indexed orderId, uint256 orderValueE18, uint256 amount);

    constructor(address hsxToken, address gateOwner, uint256 issuanceAmount) {
        if (hsxToken == address(0) || gateOwner == address(0)) revert ZeroAddress();
        if (issuanceAmount == 0) revert ZeroAmount();

        hsx = IHSXBurnable(hsxToken);
        owner = gateOwner;
        issuanceBurnAmount = issuanceAmount;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    /// @notice Burn HSX to authorize one unique market specification for submission.
    function burnToIssue(bytes32 specHash) external nonReentrant {
        if (specHash == bytes32(0)) revert ZeroSpecHash();
        if (issuedBy[specHash] != address(0)) revert AlreadyIssued(specHash);

        issuedBy[specHash] = msg.sender;
        totalBurned += issuanceBurnAmount;
        totalIssuanceBurned += issuanceBurnAmount;
        hsx.burnFrom(msg.sender, issuanceBurnAmount);

        emit IssuanceBurned(msg.sender, specHash, issuanceBurnAmount);
    }

    /// @notice Bind the issued specification to the HIP-4 outcome returned by HyperCore.
    function bindOutcome(bytes32 specHash, uint64 outcomeId) external onlyOwner {
        if (issuedBy[specHash] == address(0)) revert SpecNotIssued(specHash);
        if (isSpecBound[specHash]) revert SpecAlreadyBound(specHash);
        if (isOutcomeBound[outcomeId]) revert MarketAlreadyBound(outcomeId);

        isSpecBound[specHash] = true;
        isOutcomeBound[outcomeId] = true;
        outcomeSpec[outcomeId] = specHash;

        emit OutcomeBound(specHash, outcomeId);
    }

    /// @notice Burn 1% of an order's 18-decimal normalized quote value before submission.
    /// @dev `orderId` must be the HyperStrike agent's hash of the reviewed order draft.
    function burnToParticipate(uint64 outcomeId, bytes32 orderId, uint256 orderValueE18) external nonReentrant {
        if (!isOutcomeBound[outcomeId]) revert MarketNotBound(outcomeId);
        if (orderId == bytes32(0)) revert ZeroSpecHash();
        if (participationBurnedBy[orderId] != address(0)) revert OrderAlreadyBurned(orderId);
        uint256 participationBurnAmount = orderValueE18 / 100;
        if (participationBurnAmount == 0) revert ZeroAmount();

        participationBurnedBy[orderId] = msg.sender;
        participationBurnCount[msg.sender][outcomeId] += 1;
        totalBurned += participationBurnAmount;
        totalParticipationBurned += participationBurnAmount;
        hsx.burnFrom(msg.sender, participationBurnAmount);

        emit ParticipationBurned(msg.sender, outcomeId, orderId, orderValueE18, participationBurnAmount);
    }
}
