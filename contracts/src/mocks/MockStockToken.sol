// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockERC20} from "./MockERC20.sol";

/// @notice Test stand-in for a Robinhood Chain stock token: an ERC20 with the ERC-8056 multiplier schedule.
/// Mirrors the reference behaviour: before effectiveAt, uiMultiplier() returns the old value; newUIMultiplier()
/// returns the scheduled one; balances never rebase.
contract MockStockToken is MockERC20 {
    uint256 internal _uiMultiplier = 1e18;
    uint256 internal _newUIMultiplier = 1e18;
    uint256 internal _effectiveAt;
    bool public paused;
    bool public answers = true; // false simulates a beacon upgrade that drops the ERC-8056 reads

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    constructor(string memory _name, string memory _symbol) MockERC20(_name, _symbol, 18) {}

    function uiMultiplier() public view returns (uint256) {
        require(answers, "gone");
        return block.timestamp >= _effectiveAt ? _newUIMultiplier : _uiMultiplier;
    }

    function newUIMultiplier() external view returns (uint256) {
        require(answers, "gone");
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        require(answers, "gone");
        return _effectiveAt;
    }

    function scheduleMultiplier(uint256 next, uint256 at) external {
        require(at > block.timestamp, "future");
        uint256 current = uiMultiplier();
        _uiMultiplier = current;
        _newUIMultiplier = next;
        _effectiveAt = at;
        emit UIMultiplierUpdated(current, next, at);
    }

    event UIMultiplierUpdateCancelled();

    /// Cancel a scheduled step before it takes effect (ERC-8056 UIMultiplierUpdateCancelled).
    function cancelSchedule() external {
        require(block.timestamp < _effectiveAt, "already effective");
        _newUIMultiplier = _uiMultiplier;
        emit UIMultiplierUpdateCancelled();
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setAnswers(bool a) external {
        answers = a;
    }

    function _move(address from, address to, uint256 amount) internal override returns (bool) {
        require(!paused, "paused");
        return super._move(from, to, amount);
    }
}
