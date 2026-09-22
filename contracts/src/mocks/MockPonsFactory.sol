// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPonsV2LaunchFactory} from "../ZoltOdds.sol";

/// @notice Just enough of PonsV2LaunchFactory for the market to read: which tokens are launches, and their phase.
contract MockPonsFactory is IPonsV2LaunchFactory {
    mapping(address => LaunchedToken) private _launches;

    function launch(address token) external {
        LaunchedToken storage l = _launches[token];
        l.token = token;
        l.curve = address(uint160(uint256(keccak256(abi.encode("curve", token)))));
        l.graduationThreshold = 4.2 ether;
        l.poolFee = 0;
        l.tickSpacing = 200;
        l.exists = true;
    }

    /// @dev The real factory moves a launch NotGraduated -> Swept inside the crossing buy, then Swept -> PoolCreated
    ///      when the executor seeds the pool. Tests drive the phase directly.
    function setPhase(address token, uint8 phase) external {
        _launches[token].phase = phase;
        _launches[token].sweptAt = phase == 1 ? block.timestamp : 0;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory) {
        return _launches[token];
    }
}
