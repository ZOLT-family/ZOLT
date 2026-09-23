// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZoltOddsV2, IERC20Minimal} from "../src/ZoltOddsV2.sol";
import {IPonsV2LaunchFactory} from "../src/ZoltOdds.sol";
import {MockPonsFactory} from "../src/mocks/MockPonsFactory.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract ReentererV2 {
    ZoltOddsV2 odds;
    uint256 id;
    uint256 public hits;

    constructor(ZoltOddsV2 o) {
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

contract ZoltOddsV2Test is Test {
    MockPonsFactory factory;
    MockERC20 zolt;
    ZoltOddsV2 odds;
    address treasury = address(0xFEE);
    address token = address(0xABCD);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address keeper = address(0x6EE9);
    uint256 constant DISCOUNT = 10_000e18;
    uint256 constant KEEPER = 50_000e18;
    uint256 t0 = 1_800_000_000;

    function setUp() public {
        vm.warp(t0);
        factory = new MockPonsFactory();
        zolt = new MockERC20("Zolt", "ZOLT", 18);
        odds = new ZoltOddsV2(IPonsV2LaunchFactory(address(factory)), treasury, IERC20Minimal(address(zolt)), DISCOUNT, KEEPER);
        factory.launch(token);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        zolt.mint(alice, 3 * DISCOUNT);
        zolt.mint(keeper, 2 * KEEPER);
        vm.prank(alice);
        zolt.approve(address(odds), type(uint256).max);
        vm.prank(keeper);
        zolt.approve(address(odds), type(uint256).max);
    }

    /// @dev A 1-hour market with 1 ETH on each side, both staked at the open (equal weights).
    function _twoSided() internal returns (uint256 id) {
        id = odds.open(token, 1);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, false);
    }

    function _bondKeeper() internal {
        vm.prank(keeper);
        odds.bond(KEEPER);
    }

    // ------------------------------------------------------------------ bonds

    function test_bondLocksForSevenDaysAndEveryDepositRestartsTheLock() public {
        vm.startPrank(alice);
        odds.bond(DISCOUNT);
        assertEq(zolt.balanceOf(address(odds)), DISCOUNT);
        (uint128 amount, uint40 until) = odds.bonds(alice);
        assertEq(amount, DISCOUNT);
        assertEq(until, t0 + 7 days);

        vm.expectRevert(abi.encodeWithSelector(ZoltOddsV2.BondLocked.selector, uint40(t0 + 7 days)));
        odds.unbond(1);

        vm.warp(t0 + 7 days);
        odds.unbond(4_000e18);
        (amount,) = odds.bonds(alice);
        assertEq(amount, 6_000e18);
        assertEq(zolt.balanceOf(alice), 3 * DISCOUNT - 6_000e18);

        // topping up restarts the lock on the whole bond
        odds.bond(1);
        (, until) = odds.bonds(alice);
        assertEq(until, t0 + 14 days);
        vm.expectRevert(abi.encodeWithSelector(ZoltOddsV2.BondLocked.selector, uint40(t0 + 14 days)));
        odds.unbond(1);

        // never more than what is there, never nothing
        vm.warp(t0 + 14 days);
        vm.expectRevert(ZoltOddsV2.ZeroAmount.selector);
        odds.unbond(6_000e18 + 2);
        vm.expectRevert(ZoltOddsV2.ZeroAmount.selector);
        odds.unbond(0);
        vm.stopPrank();
    }

    function test_bondNeedsTokens() public {
        vm.prank(bob); // holds no ZOLT and gave no allowance
        vm.expectRevert(ZoltOddsV2.TokenTransferFailed.selector);
        odds.bond(1);
    }

    function test_feeAndKeeperStatusFollowTheBond() public {
        assertEq(odds.feeBpsOf(alice), 100);
        assertFalse(odds.isKeeper(alice));
        vm.startPrank(alice);
        odds.bond(DISCOUNT - 1);
        assertEq(odds.feeBpsOf(alice), 100);
        odds.bond(1);
        assertEq(odds.feeBpsOf(alice), 50);
        assertFalse(odds.isKeeper(alice));
        vm.stopPrank();
        _bondKeeper();
        assertTrue(odds.isKeeper(keeper));
        assertEq(odds.feeBpsOf(keeper), 50); // the keeper bond is the larger one, so it carries the discount too
    }

    // ------------------------------------------------------------------ bounty

    function test_bondedWitnessIsPaidTheBountyOutOfTheLosingPool() public {
        uint256 id = _twoSided();
        _bondKeeper();
        vm.warp(t0 + 1 hours + 1);
        uint256 before = keeper.balance;
        vm.prank(keeper);
        odds.witnessNo(id);
        // 0.2% of the 1 ETH YES pool
        assertEq(keeper.balance - before, 0.002 ether);
        assertEq(odds.market(id).bounty, 0.002 ether);

        // the winner's share is the losing pool less the bounty, and the fee is 1% of that share
        (uint256 amount, uint256 fee) = odds.payoutAndFee(id, bob);
        uint256 share = 1 ether - 0.002 ether;
        assertEq(fee, share / 100);
        assertEq(amount, 1 ether + share - share / 100);
        uint256 tBefore = treasury.balance;
        vm.prank(bob);
        odds.claim(id);
        assertEq(treasury.balance - tBefore, share / 100);
        // nothing is left in the contract but rounding dust
        assertLe(address(odds).balance, 2);
    }

    function test_witnessWithoutTheBondIsNotPaid() public {
        uint256 id = _twoSided();
        vm.warp(t0 + 1 hours + 1);
        uint256 before = carol.balance;
        vm.prank(carol);
        odds.witnessNo(id);
        assertEq(carol.balance, before);
        assertEq(odds.market(id).bounty, 0);
        (uint256 amount, uint256 fee) = odds.payoutAndFee(id, bob);
        assertEq(fee, 0.01 ether);
        assertEq(amount, 2 ether - 0.01 ether);
    }

    function test_yesWitnessIsPaidTheSameWay() public {
        uint256 id = _twoSided();
        _bondKeeper();
        factory.setPhase(token, 1);
        uint256 before = keeper.balance;
        vm.prank(keeper);
        odds.witnessYes(id);
        assertEq(keeper.balance - before, 0.002 ether); // 0.2% of the NO pool
        (uint256 amount,) = odds.payoutAndFee(id, alice);
        uint256 share = 1 ether - 0.002 ether;
        assertEq(amount, 1 ether + share - share / 100);
    }

    function test_noBountyAndNoFeeOnAVoidMarket() public {
        uint256 id = odds.open(token, 1);
        vm.prank(alice);
        odds.stake{value: 1 ether}(id, true); // one side only
        _bondKeeper();
        vm.warp(t0 + 1 hours + 1);
        uint256 before = keeper.balance;
        vm.prank(keeper);
        odds.witnessNo(id);
        assertEq(uint8(odds.market(id).outcome), uint8(ZoltOddsV2.Outcome.Void));
        assertEq(keeper.balance, before);
        assertEq(odds.market(id).bounty, 0);
        (uint256 amount, uint256 fee) = odds.payoutAndFee(id, alice);
        assertEq(amount, 1 ether);
        assertEq(fee, 0);
    }

    // ------------------------------------------------------------------ fee discount

    function test_bondedWinnerPaysHalfTheFee() public {
        uint256 id = _twoSided();
        vm.prank(alice);
        odds.bond(DISCOUNT);
        factory.setPhase(token, 1);
        vm.prank(carol);
        odds.witnessYes(id);

        (uint256 amount, uint256 fee) = odds.payoutAndFee(id, alice);
        assertEq(fee, 0.005 ether); // 0.5% of the 1 ETH share
        assertEq(amount, 2 ether - 0.005 ether);
        uint256 tBefore = treasury.balance;
        uint256 aBefore = alice.balance;
        vm.prank(alice);
        odds.claim(id);
        assertEq(alice.balance - aBefore, 2 ether - 0.005 ether);
        assertEq(treasury.balance - tBefore, 0.005 ether);
    }

    function test_theFeeIsReadAtClaimSoABondPlacedAfterResolutionCountsAndIsLocked() public {
        uint256 id = _twoSided();
        factory.setPhase(token, 1);
        vm.prank(carol);
        odds.witnessYes(id);
        (, uint256 feeBefore) = odds.payoutAndFee(id, alice);
        assertEq(feeBefore, 0.01 ether);

        vm.startPrank(alice);
        odds.bond(DISCOUNT);
        (, uint256 feeAfter) = odds.payoutAndFee(id, alice);
        assertEq(feeAfter, 0.005 ether);
        odds.claim(id);
        // the discount cost a week of the bond: it cannot come straight back out
        vm.expectRevert(abi.encodeWithSelector(ZoltOddsV2.BondLocked.selector, uint40(t0 + 7 days)));
        odds.unbond(DISCOUNT);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ what v1 already promised

    function test_openAndStakeReusesTheOpenMarket() public {
        vm.prank(alice);
        uint256 a = odds.openAndStake{value: 0.5 ether}(token, 0, true);
        vm.prank(bob);
        uint256 b = odds.openAndStake{value: 0.5 ether}(token, 0, false);
        assertEq(a, b);
        assertEq(odds.marketCount(), 1);
        assertEq(odds.market(a).yesPool, 0.5 ether);
        assertEq(odds.market(a).noPool, 0.5 ether);
    }

    function test_claimPaysOnceAndOnlyWinners() public {
        uint256 id = _twoSided();
        vm.warp(t0 + 1 hours + 1);
        odds.witnessNo(id);
        vm.prank(alice);
        vm.expectRevert(ZoltOddsV2.NothingToClaim.selector);
        odds.claim(id);
        vm.startPrank(bob);
        odds.claim(id);
        vm.expectRevert(ZoltOddsV2.NothingToClaim.selector);
        odds.claim(id);
        vm.stopPrank();
    }

    function test_claimIsNotReenterable() public {
        ReentererV2 r = new ReentererV2(odds);
        uint256 id = odds.open(token, 1);
        r.stakeYes{value: 1 ether}(id);
        vm.prank(bob);
        odds.stake{value: 1 ether}(id, false);
        factory.setPhase(token, 1);
        odds.witnessYes(id);
        r.claim();
        assertEq(r.hits(), 1);
        assertEq(address(r).balance, 2 ether - 0.01 ether);
        assertEq(odds.payout(id, address(r)), 0);
    }

    function test_marketWordsMatchTheV1LayoutWithBountyAppended() public {
        uint256 id = _twoSided();
        bytes memory enc = abi.encode(odds.market(id));
        assertEq(enc.length, 11 * 32);
        assertEq(_word(enc, 0), uint256(uint160(token)));
        assertEq(_word(enc, 1), t0); // openedAt
        assertEq(_word(enc, 2), t0 + 30 minutes); // closesAt
        assertEq(_word(enc, 3), t0 + 1 hours); // deadline
        assertEq(_word(enc, 4), 1); // window
        assertEq(_word(enc, 5), 0); // outcome
        assertEq(_word(enc, 6), 1 ether); // yesPool
        assertEq(_word(enc, 7), 1 ether); // noPool
        assertEq(_word(enc, 8), 1 ether * 30 minutes); // yesWeight
        assertEq(_word(enc, 9), 1 ether * 30 minutes); // noWeight
        assertEq(_word(enc, 10), 0); // bounty
    }

    function test_constructorRejectsZeroes() public {
        vm.expectRevert(bytes("zero"));
        new ZoltOddsV2(IPonsV2LaunchFactory(address(0)), treasury, IERC20Minimal(address(zolt)), 1, 1);
        vm.expectRevert(bytes("zero"));
        new ZoltOddsV2(IPonsV2LaunchFactory(address(factory)), treasury, IERC20Minimal(address(0)), 1, 1);
        vm.expectRevert(bytes("zero bond"));
        new ZoltOddsV2(IPonsV2LaunchFactory(address(factory)), treasury, IERC20Minimal(address(zolt)), 0, 1);
    }

    // ------------------------------------------------------------------ accounting

    function testFuzz_everyWeiIsAccountedFor(
        uint96 a,
        uint96 b,
        uint96 c,
        uint32 dt,
        bool yesWins,
        bool bondedWitness,
        bool aliceBonded
    ) public {
        a = uint96(bound(a, 0.0001 ether, 50 ether));
        b = uint96(bound(b, 0.0001 ether, 50 ether));
        c = uint96(bound(c, 0.0001 ether, 50 ether));
        dt = uint32(bound(dt, 0, 1799));
        uint256 id = odds.open(token, 1);
        if (aliceBonded) {
            vm.prank(alice);
            odds.bond(DISCOUNT);
        }
        vm.prank(alice);
        odds.stake{value: a}(id, true);
        vm.prank(bob);
        odds.stake{value: b}(id, false);
        vm.warp(t0 + dt);
        vm.prank(carol);
        odds.stake{value: c}(id, true);

        if (yesWins) factory.setPhase(token, 1);
        else vm.warp(t0 + 1 hours + 1);
        address witness = bondedWitness ? keeper : address(0xD00D);
        if (bondedWitness) _bondKeeper();
        uint256 wBefore = witness.balance;
        vm.prank(witness);
        if (yesWins) odds.witnessYes(id);
        else odds.witnessNo(id);
        uint256 bounty = witness.balance - wBefore;
        assertEq(bounty, odds.market(id).bounty);
        if (!bondedWitness) assertEq(bounty, 0);

        uint256 tBefore = treasury.balance;
        uint256 paid;
        address[3] memory who = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            (uint256 amount,) = odds.payoutAndFee(id, who[i]);
            if (amount == 0) continue;
            vm.prank(who[i]);
            odds.claim(id);
            paid += amount;
        }
        uint256 fees = treasury.balance - tBefore;
        uint256 pools = uint256(a) + b + c;
        assertLe(paid + fees + bounty, pools);
        assertGe(paid + fees + bounty + 4, pools); // at most a wei of rounding per division
        assertEq(address(odds).balance, pools - paid - fees - bounty);
    }

    function _word(bytes memory enc, uint256 i) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(enc, add(32, mul(i, 32))))
        }
    }
}
