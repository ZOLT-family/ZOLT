// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The market against Pons's real contracts, on a fork of chain 4663. Nothing is mocked: the factory, the curve and
// the graduation path are the ones on mainnet. Opt-in, because it needs a fork endpoint and a live launch:
//
//   RH_FORK=1 RH_FORK_RPC=http://127.0.0.1:4535 RH_FORK_TOKEN=0x... npx hardhat test solidity
//
// RH_FORK_TOKEN is a Pons V2 launch that is still on its curve at the fork block (pick one from the board).
import {Test} from "forge-std/Test.sol";
import {ZoltOdds, IPonsV2LaunchFactory} from "../src/ZoltOdds.sol";

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function realQuoteReserve() external view returns (uint256);
    function graduated() external view returns (bool);
}

contract ZoltOddsForkTest is Test {
    IPonsV2LaunchFactory constant FACTORY = IPonsV2LaunchFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function _forkOrSkip() internal returns (bool) {
        if (!vm.envOr("RH_FORK", false)) return false;
        vm.createSelectFork(vm.envOr("RH_FORK_RPC", string("http://127.0.0.1:4535")));
        return true;
    }

    /// Buys the curve with fresh wallets until Pons itself moves the launch out of NotGraduated.
    function _pushToGraduation(address curve, address token) internal {
        for (uint256 i = 0; i < 60; i++) {
            if (FACTORY.getLaunchedToken(token).phase != 0) return;
            address buyer = address(uint160(0xB00B5 + i));
            vm.deal(buyer, 10 ether);
            vm.prank(buyer);
            // launch protection caps a wallet's share, so buy in one-ETH steps from many wallets; a refused buy is fine
            try IPonsCurve(curve).buy{value: 1 ether}(1 ether, 0, buyer) {} catch {}
        }
    }

    function test_fork_marketResolvesYesWhenPonsGraduatesTheLaunch() public {
        if (!_forkOrSkip()) return;
        address token = vm.envAddress("RH_FORK_TOKEN");
        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(token);
        assertTrue(l.exists, "not a Pons launch");
        assertEq(l.phase, 0, "launch already left its curve; pick another");

        ZoltOdds odds = new ZoltOdds(FACTORY, treasury);
        uint256 id = odds.open(token, 1);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(alice);
        odds.stake{value: 0.2 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 0.8 ether}(id, false);
        // on a fork the treasury address may already hold mainnet dust; measure the fee as a delta
        uint256 treasuryBefore = treasury.balance;

        uint256 before = IPonsCurve(l.curve).realQuoteReserve();
        _pushToGraduation(l.curve, token);
        uint8 phase = FACTORY.getLaunchedToken(token).phase;
        assertTrue(phase != 0, "the curve did not graduate; the launch may be capped harder than 60 x 1 ETH");
        emit log_named_uint("curve reserve before (wei)", before);
        emit log_named_uint("phase after the crossing buy", phase);

        // once graduated, nobody can stake any more
        vm.deal(address(0xC0FFEE), 1 ether);
        vm.prank(address(0xC0FFEE));
        vm.expectRevert(ZoltOdds.AlreadyGraduated.selector);
        odds.stake{value: 0.1 ether}(id, true);

        odds.witnessYes(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOdds.Outcome.Yes));
        assertEq(odds.payout(id, alice), 0.2 ether + 0.8 ether - 0.008 ether);
        assertEq(odds.payout(id, bob), 0);
        assertEq(treasury.balance - treasuryBefore, 0.008 ether);
        vm.prank(alice);
        odds.claim(id);
        assertEq(alice.balance, 1 ether - 0.2 ether + 0.992 ether);
    }

    function test_fork_marketResolvesNoWhenTheDeadlinePassesOnTheCurve() public {
        if (!_forkOrSkip()) return;
        address token = vm.envAddress("RH_FORK_TOKEN");
        assertEq(FACTORY.getLaunchedToken(token).phase, 0, "launch already left its curve; pick another");

        ZoltOdds odds = new ZoltOdds(FACTORY, treasury);
        uint256 id = odds.open(token, 0);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(alice);
        odds.stake{value: 0.1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 0.1 ether}(id, false);

        vm.expectRevert(ZoltOdds.TooEarly.selector);
        odds.witnessNo(id);
        vm.warp(block.timestamp + 10 minutes + 1);
        odds.witnessNo(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOdds.Outcome.No));
        assertEq(odds.payout(id, bob), 0.1 ether + 0.1 ether - 0.001 ether);
        assertEq(odds.payout(id, alice), 0);
    }
}
