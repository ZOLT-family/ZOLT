// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZoltOdds, IPonsV2LaunchFactory} from "../src/ZoltOdds.sol";
import {MockPonsFactory} from "../src/mocks/MockPonsFactory.sol";

contract Reenterer {
    ZoltOdds odds;
    uint256 id;
    uint256 public hits;

    constructor(ZoltOdds o) {
        odds = o;
    }

    function stakeYes(uint256 id_) external payable {
        id = id_;
        odds.stake{value: msg.value}(id_, true);
    }

    function claim() external {
        odds.claim(id);
    }

    receive() external payable {
        hits++;
        if (hits == 1) {
            try odds.claim(id) {} catch {}
        }
    }
}

contract ZoltOddsTest is Test {
    MockPonsFactory factory;
    ZoltOdds odds;
    address treasury = address(0xFEE);
    address token = address(0xABCD);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    uint256 t0 = 1_800_000_000;

    function setUp() public {
        vm.warp(t0);
        factory = new MockPonsFactory();
        odds = new ZoltOdds(IPonsV2LaunchFactory(address(factory)), treasury);
        factory.launch(token);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ------------------------------------------------------------------ opening

    function test_openRequiresAPonsLaunchStillOnItsCurve() public {
        vm.expectRevert(ZoltOdds.NotALaunch.selector);
        odds.open(address(0xBEEF), 1);

        factory.setPhase(token, 2);
        vm.expectRevert(ZoltOdds.AlreadyGraduated.selector);
        odds.open(token, 1);
    }

    function test_openSetsTheWindowAndRefusesADuplicate() public {
        uint256 id = odds.open(token, 1);
        ZoltOdds.Market memory m = odds.market(id);
        assertEq(m.closesAt, t0 + 30 minutes);
        assertEq(m.deadline, t0 + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ZoltOdds.MarketExists.selector, id));
        odds.open(token, 1);
        // a different window is a different market
        uint256 id2 = odds.open(token, 0);
        assertEq(odds.market(id2).deadline, t0 + 10 minutes);
    }

    function test_badWindowReverts() public {
        vm.expectRevert(ZoltOdds.BadWindow.selector);
        odds.open(token, 3);
    }

    // ------------------------------------------------------------------ staking

    function test_stakeWeightFallsToZeroAtClose() public {
        uint256 id = odds.open(token, 1); // closes at t0 + 30 min
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.warp(t0 + 15 minutes);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, true);
        ZoltOdds.Position memory pa = odds.position(id, alice);
        ZoltOdds.Position memory pb = odds.position(id, bob);
        assertEq(pa.yesWeight, 1 ether * 30 minutes);
        assertEq(pb.yesWeight, 1 ether * 15 minutes);
        vm.warp(t0 + 30 minutes);
        vm.prank(carol);
        vm.expectRevert(ZoltOdds.StakingClosed.selector);
        odds.stake{value: 1 ether}(id, true);
    }

    function test_noStakesOnceTheLaunchHasGraduated() public {
        uint256 id = odds.open(token, 1);
        factory.setPhase(token, 1);
        vm.prank(alice);
        vm.expectRevert(ZoltOdds.AlreadyGraduated.selector);
        odds.stake{value: 1 ether}(id, true);
    }

    function test_minimumStake() public {
        uint256 id = odds.open(token, 1);
        vm.prank(alice);
        vm.expectRevert(ZoltOdds.StakeTooSmall.selector);
        odds.stake{value: 0.00001 ether}(id, true);
    }

    function test_openAndStakeReusesTheOpenMarket() public {
        vm.prank(alice);
        uint256 a = odds.openAndStake{value: 1 ether}(token, 1, true);
        vm.prank(bob);
        uint256 b = odds.openAndStake{value: 2 ether}(token, 1, false);
        assertEq(a, b);
        assertEq(odds.market(a).yesPool, 1 ether);
        assertEq(odds.market(a).noPool, 2 ether);
        assertEq(odds.impliedYesBps(a), 3333);
    }

    // ------------------------------------------------------------------ resolution

    function test_yesIsWitnessedOnlyBeforeTheDeadlineAndOnlyAfterGraduation() public {
        uint256 id = odds.open(token, 1);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 3 ether}(id, false);

        vm.expectRevert(ZoltOdds.StillOnCurve.selector);
        odds.witnessYes(id);

        factory.setPhase(token, 1); // swept inside the crossing buy
        vm.warp(t0 + 59 minutes);
        odds.witnessYes(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOdds.Outcome.Yes));

        // alice wins bob's 3 ETH minus the 1% fee on top of her own 1 ETH
        assertEq(odds.payout(id, alice), 1 ether + 3 ether - 0.03 ether);
        assertEq(odds.payout(id, bob), 0);
        assertEq(treasury.balance, 0.03 ether);
    }

    function test_yesCannotBeWitnessedAfterTheDeadline() public {
        uint256 id = odds.open(token, 0);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, false);
        vm.warp(t0 + 10 minutes + 1);
        factory.setPhase(token, 2);
        vm.expectRevert(ZoltOdds.TooLate.selector);
        odds.witnessYes(id);
    }

    function test_noIsWitnessedOnlyAfterTheDeadlineWhileStillOnCurve() public {
        uint256 id = odds.open(token, 0);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, false);

        vm.expectRevert(ZoltOdds.TooEarly.selector);
        odds.witnessNo(id);

        vm.warp(t0 + 10 minutes + 1);
        odds.witnessNo(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOdds.Outcome.No));
        assertEq(odds.payout(id, bob), 1 ether + 1 ether - 0.01 ether);
        assertEq(odds.payout(id, alice), 0);
    }

    function test_aGraduationAfterTheDeadlineThatNobodyWitnessedIsVoidedAndRefunded() public {
        uint256 id = odds.open(token, 0);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 2 ether}(id, false);

        vm.warp(t0 + 11 minutes);
        factory.setPhase(token, 2); // graduated after the deadline, before anyone recorded NO
        vm.expectRevert(ZoltOdds.AlreadyGraduated.selector);
        odds.witnessNo(id);
        vm.expectRevert(ZoltOdds.TooLate.selector);
        odds.witnessYes(id);
        vm.expectRevert(ZoltOdds.TooEarly.selector);
        odds.voidUnobserved(id);

        vm.warp(t0 + 10 minutes + 1 days + 1);
        odds.voidUnobserved(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOdds.Outcome.Void));
        assertEq(odds.payout(id, alice), 1 ether);
        assertEq(odds.payout(id, bob), 2 ether);
        assertEq(treasury.balance, 0);
    }

    function test_oneSidedMarketIsRefundedNotPaid() public {
        uint256 id = odds.open(token, 1);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        factory.setPhase(token, 2);
        odds.witnessYes(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOdds.Outcome.Void));
        assertEq(odds.payout(id, alice), 1 ether);
        assertEq(treasury.balance, 0);
    }

    function test_resolvedMarketFreesTheSlotForANewOne() public {
        uint256 id = odds.open(token, 0);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.warp(t0 + 10 minutes + 1);
        odds.witnessNo(id);
        assertEq(odds.openMarket(token, 0), 0);
        uint256 id2 = odds.open(token, 0);
        assertEq(id2, id + 1);
    }

    // ------------------------------------------------------------------ claiming

    function test_claimPaysOnceAndOnlyWinners() public {
        uint256 id = odds.open(token, 1);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, false);
        factory.setPhase(token, 2);
        odds.witnessYes(id);

        uint256 before = alice.balance;
        vm.prank(alice);
        odds.claim(id);
        assertEq(alice.balance - before, 1.99 ether);
        vm.prank(alice);
        vm.expectRevert(ZoltOdds.NothingToClaim.selector);
        odds.claim(id);
        vm.prank(bob);
        vm.expectRevert(ZoltOdds.NothingToClaim.selector);
        odds.claim(id);
        assertEq(address(odds).balance, 0);
    }

    function test_earlyMoneyIsNotDilutedByLateMoney() public {
        uint256 id = odds.open(token, 1); // staking closes at t0 + 30 min
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true); // weight 1 * 30 min
        vm.prank(carol);
        odds.stake{value: 10 ether}(id, false);
        vm.warp(t0 + 30 minutes - 1);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, true); // weight 1 * 1 s
        factory.setPhase(token, 2);
        odds.witnessYes(id);
        uint256 pot = 10 ether - 0.1 ether;
        uint256 total = 1 ether * 30 minutes + 1 ether * 1;
        assertEq(odds.payout(id, alice), 1 ether + pot * (1 ether * 30 minutes) / total);
        assertEq(odds.payout(id, bob), 1 ether + pot * (1 ether * 1) / total);
        // the two shares differ from the pot only by division dust
        assertApproxEqAbs(odds.payout(id, alice) + odds.payout(id, bob), 2 ether + pot, 1);
        assertLt(odds.payout(id, bob), 1 ether + 0.01 ether);
    }

    function test_claimIsNotReenterable() public {
        Reenterer r = new Reenterer(odds);
        vm.deal(address(r), 10 ether);
        uint256 id = odds.open(token, 1);
        r.stakeYes{value: 1 ether}(id);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, false);
        factory.setPhase(token, 2);
        odds.witnessYes(id);
        r.claim();
        // the stake was forwarded from this test's balance, so the attacker keeps its 10 ETH and gains one payout
        assertEq(address(r).balance, 10 ether + 1.99 ether);
        assertEq(r.hits(), 1);
        assertEq(address(odds).balance, 0);
    }

    // ------------------------------------------------------------------ conservation

    function testFuzz_everyWeiIsAccountedFor(uint96 a, uint96 b, uint96 c, uint32 dt, bool yesWins) public {
        a = uint96(bound(a, 0.0001 ether, 50 ether));
        b = uint96(bound(b, 0.0001 ether, 50 ether));
        c = uint96(bound(c, 0.0001 ether, 50 ether));
        dt = uint32(bound(dt, 0, 30 minutes - 1));
        uint256 id = odds.open(token, 1);
        vm.prank(alice);
        odds.stake{value: a}(id, true);
        vm.prank(bob);
        odds.stake{value: b}(id, false);
        vm.warp(t0 + dt);
        vm.prank(carol);
        odds.stake{value: c}(id, yesWins);
        if (yesWins) {
            factory.setPhase(token, 1);
            odds.witnessYes(id);
        } else {
            vm.warp(t0 + 1 hours + 1);
            odds.witnessNo(id);
        }
        uint256 pa = odds.payout(id, alice);
        uint256 pb = odds.payout(id, bob);
        uint256 pc = odds.payout(id, carol);
        uint256 pools = uint256(a) + b + c;
        uint256 fee = treasury.balance;
        // rounding can only ever leave dust inside the contract, never create it
        assertLe(pa + pb + pc + fee, pools);
        assertGe(pa + pb + pc + fee + 3, pools);
        if (pa > 0) {
            vm.prank(alice);
            odds.claim(id);
        }
        if (pb > 0) {
            vm.prank(bob);
            odds.claim(id);
        }
        if (pc > 0) {
            vm.prank(carol);
            odds.claim(id);
        }
        assertLe(address(odds).balance, 3);
    }
}
