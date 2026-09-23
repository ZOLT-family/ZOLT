// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPonsV2LaunchFactory} from "./ZoltOdds.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title Zolt Odds v2
/// @notice The same Yes/No parimutuel on Pons V2 launches as ZoltOdds, with the ZOLT token given two jobs:
///
///         1. A fee discount. A winner who has bonded at least `discountBond` ZOLT pays 0.5% on the share of
///            the losing pool they take home instead of 1%. The fee is charged at claim, per winner.
///         2. A witness bounty. Whoever records a market's outcome while bonded with at least `keeperBond`
///            ZOLT is paid 0.2% of the losing pool on the spot. Recording is still open to anyone; the bond
///            only decides who is paid for it. Outcomes are read from the factory, so there is nothing a
///            witness could lie about and nothing to slash.
///
///         A bond is locked for seven days from the last deposit, so it cannot be flashed around a claim.
///         Void markets pay no fee and no bounty. No oracle, no committee, no owner.
contract ZoltOddsV2 {
    // ------------------------------------------------------------------ types

    enum Outcome {
        Open,
        Yes,
        No,
        Void
    }

    /// @dev The first ten fields are laid out exactly as ZoltOdds.Market, so a reader of `market()` decodes the
    ///      same words; `bounty` is appended.
    struct Market {
        address token;
        uint40 openedAt;
        uint40 closesAt; // no stakes after this
        uint40 deadline; // graduation must be witnessed on or before this
        uint8 window; // index into windowSeconds
        Outcome outcome;
        uint128 yesPool;
        uint128 noPool;
        uint256 yesWeight;
        uint256 noWeight;
        uint128 bounty; // paid to the witness out of the losing pool; zero when the witness was not bonded
    }

    struct Position {
        uint128 yes;
        uint128 no;
        uint256 yesWeight;
        uint256 noWeight;
        bool claimed;
    }

    struct Bond {
        uint128 amount;
        uint40 lockedUntil;
    }

    // ------------------------------------------------------------------ constants

    uint256 public constant FEE_BPS = 100; // 1% of a winner's share of the losing pool
    uint256 public constant DISCOUNT_FEE_BPS = 50; // 0.5% for a winner bonded with discountBond
    uint256 public constant BOUNTY_BPS = 20; // 0.2% of the losing pool to a bonded witness
    uint256 public constant BOND_LOCK = 7 days;
    uint256 public constant VOID_AFTER = 1 days;
    uint256 public constant MIN_STAKE = 0.0001 ether;
    uint8 public constant WINDOW_COUNT = 3;

    // ------------------------------------------------------------------ state

    IPonsV2LaunchFactory public immutable factory;
    address public immutable treasury;
    IERC20Minimal public immutable zolt;
    uint256 public immutable discountBond;
    uint256 public immutable keeperBond;

    Market[] private _markets;
    mapping(address token => mapping(uint8 window => uint256 idPlusOne)) public openMarket;
    mapping(uint256 id => mapping(address who => Position)) private _positions;
    mapping(address who => Bond) public bonds;

    uint256 private _lock;

    // ------------------------------------------------------------------ events

    event MarketOpened(uint256 indexed id, address indexed token, uint8 window, uint40 closesAt, uint40 deadline);
    event Staked(uint256 indexed id, address indexed who, bool yes, uint256 amount, uint256 weight);
    event Resolved(uint256 indexed id, Outcome outcome, address indexed by);
    event BountyPaid(uint256 indexed id, address indexed to, uint256 amount);
    event Claimed(uint256 indexed id, address indexed who, uint256 amount);
    event FeeTaken(uint256 indexed id, uint256 amount);
    event Bonded(address indexed who, uint256 amount, uint256 total, uint40 lockedUntil);
    event Unbonded(address indexed who, uint256 amount, uint256 total);

    // ------------------------------------------------------------------ errors

    error NotALaunch();
    error AlreadyGraduated();
    error MarketExists(uint256 id);
    error BadWindow();
    error StakeTooSmall();
    error StakingClosed();
    error NotOpen();
    error TooEarly();
    error TooLate();
    error StillOnCurve();
    error NothingToClaim();
    error Reentrancy();
    error SendFailed();
    error ZeroAmount();
    error BondLocked(uint40 until);
    error BondTooSmall();
    error TokenTransferFailed();

    constructor(
        IPonsV2LaunchFactory factory_,
        address treasury_,
        IERC20Minimal zolt_,
        uint256 discountBond_,
        uint256 keeperBond_
    ) {
        require(address(factory_) != address(0) && treasury_ != address(0) && address(zolt_) != address(0), "zero");
        require(discountBond_ > 0 && keeperBond_ > 0, "zero bond");
        factory = factory_;
        treasury = treasury_;
        zolt = zolt_;
        discountBond = discountBond_;
        keeperBond = keeperBond_;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    // ------------------------------------------------------------------ bonds

    /// @notice Lock ZOLT here. Every deposit restarts the seven-day lock on the whole bond.
    function bond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _pull(msg.sender, amount);
        Bond storage b = bonds[msg.sender];
        b.amount += uint128(amount);
        b.lockedUntil = uint40(block.timestamp + BOND_LOCK);
        emit Bonded(msg.sender, amount, b.amount, b.lockedUntil);
    }

    /// @notice Take ZOLT back once the lock has run out.
    function unbond(uint256 amount) external nonReentrant {
        Bond storage b = bonds[msg.sender];
        if (amount == 0 || amount > b.amount) revert ZeroAmount();
        if (block.timestamp < b.lockedUntil) revert BondLocked(b.lockedUntil);
        b.amount -= uint128(amount);
        emit Unbonded(msg.sender, amount, b.amount);
        _push(msg.sender, amount);
    }

    /// @notice The fee `who` pays on a winning share today.
    function feeBpsOf(address who) public view returns (uint256) {
        return bonds[who].amount >= discountBond ? DISCOUNT_FEE_BPS : FEE_BPS;
    }

    /// @notice Whether `who` would be paid the bounty for recording an outcome.
    function isKeeper(address who) public view returns (bool) {
        return bonds[who].amount >= keeperBond;
    }

    // ------------------------------------------------------------------ windows

    /// @dev Staking is open for the first half of the window; the second half is for the graduation to happen.
    ///      Total windows, in seconds: 10 minutes, 1 hour, 6 hours.
    function windowSeconds(uint8 window) public pure returns (uint40 total) {
        if (window == 0) return 10 minutes;
        if (window == 1) return 1 hours;
        if (window == 2) return 6 hours;
        revert BadWindow();
    }

    // ------------------------------------------------------------------ open + stake

    /// @notice Open a market on a Pons launch that is still on its curve. Anyone can, for any launch.
    function open(address token, uint8 window) public returns (uint256 id) {
        uint40 total = windowSeconds(window);
        if (openMarket[token][window] != 0) revert MarketExists(openMarket[token][window] - 1);
        _requireOnCurve(token);

        id = _markets.length;
        uint40 now_ = uint40(block.timestamp);
        _markets.push(
            Market({
                token: token,
                openedAt: now_,
                closesAt: now_ + total / 2,
                deadline: now_ + total,
                window: window,
                outcome: Outcome.Open,
                yesPool: 0,
                noPool: 0,
                yesWeight: 0,
                noWeight: 0,
                bounty: 0
            })
        );
        openMarket[token][window] = id + 1;
        emit MarketOpened(id, token, window, now_ + total / 2, now_ + total);
    }

    /// @notice Stake ETH on a side. Weight falls linearly to zero at the close of staking.
    function stake(uint256 id, bool yes) public payable {
        Market storage m = _markets[id];
        if (m.outcome != Outcome.Open) revert NotOpen();
        if (block.timestamp >= m.closesAt) revert StakingClosed();
        if (msg.value < MIN_STAKE) revert StakeTooSmall();
        _requireOnCurve(m.token); // once it has graduated the answer is known; no more stakes either way

        uint256 weight = msg.value * (m.closesAt - block.timestamp);
        Position storage p = _positions[id][msg.sender];
        if (yes) {
            m.yesPool += uint128(msg.value);
            m.yesWeight += weight;
            p.yes += uint128(msg.value);
            p.yesWeight += weight;
        } else {
            m.noPool += uint128(msg.value);
            m.noWeight += weight;
            p.no += uint128(msg.value);
            p.noWeight += weight;
        }
        emit Staked(id, msg.sender, yes, msg.value, weight);
    }

    /// @notice Open and stake in one transaction, or stake into the market that is already open for this window.
    function openAndStake(address token, uint8 window, bool yes) external payable returns (uint256 id) {
        uint256 existing = openMarket[token][window];
        id = existing == 0 ? open(token, window) : existing - 1;
        stake(id, yes);
    }

    // ------------------------------------------------------------------ resolve

    /// @notice Record that the launch graduated before the deadline. Anyone may call it; YES holders will.
    function witnessYes(uint256 id) external nonReentrant {
        Market storage m = _markets[id];
        if (m.outcome != Outcome.Open) revert NotOpen();
        if (block.timestamp > m.deadline) revert TooLate();
        if (_phase(m.token) == 0) revert StillOnCurve();
        _resolve(id, m, Outcome.Yes);
    }

    /// @notice Record that the deadline passed with the launch still on its curve. Anyone may call it.
    function witnessNo(uint256 id) external nonReentrant {
        Market storage m = _markets[id];
        if (m.outcome != Outcome.Open) revert NotOpen();
        if (block.timestamp <= m.deadline) revert TooEarly();
        if (_phase(m.token) != 0) revert AlreadyGraduated();
        _resolve(id, m, Outcome.No);
    }

    /// @notice A market nobody could witness either way (it graduated after the deadline, before anyone recorded
    ///         NO) is voided a day after its deadline and every stake is refunded.
    function voidUnobserved(uint256 id) external nonReentrant {
        Market storage m = _markets[id];
        if (m.outcome != Outcome.Open) revert NotOpen();
        if (block.timestamp <= uint256(m.deadline) + VOID_AFTER) revert TooEarly();
        _resolve(id, m, Outcome.Void);
    }

    function _resolve(uint256 id, Market storage m, Outcome o) private {
        // a market with one empty side has nobody to pay and nobody to pay from: refund it
        if (o != Outcome.Void && (m.yesPool == 0 || m.noPool == 0)) o = Outcome.Void;
        m.outcome = o;
        delete openMarket[m.token][m.window];
        emit Resolved(id, o, msg.sender);

        // the witness bounty comes off the top of the losing pool, only for a bonded witness
        if ((o == Outcome.Yes || o == Outcome.No) && isKeeper(msg.sender)) {
            uint256 losing = o == Outcome.Yes ? m.noPool : m.yesPool;
            uint256 bounty = losing * BOUNTY_BPS / 10_000;
            if (bounty > 0) {
                m.bounty = uint128(bounty);
                emit BountyPaid(id, msg.sender, bounty);
                _send(msg.sender, bounty);
            }
        }
    }

    // ------------------------------------------------------------------ claim

    /// @notice What `who` takes out of a resolved market and what the treasury takes from it: a winner's principal
    ///         plus a weighted share of the losing pool, less the fee on that share; principal back for a void
    ///         market; nothing for losers.
    function payoutAndFee(uint256 id, address who) public view returns (uint256 amount, uint256 fee) {
        Market storage m = _markets[id];
        Position storage p = _positions[id][who];
        if (m.outcome == Outcome.Open || p.claimed) return (0, 0);
        if (m.outcome == Outcome.Void) return (uint256(p.yes) + p.no, 0);

        bool yesWon = m.outcome == Outcome.Yes;
        uint256 principal = yesWon ? p.yes : p.no;
        if (principal == 0) return (0, 0);
        uint256 weight = yesWon ? p.yesWeight : p.noWeight;
        uint256 totalWeight = yesWon ? m.yesWeight : m.noWeight;
        uint256 losing = yesWon ? m.noPool : m.yesPool;
        uint256 pot = losing - m.bounty;
        // a winning side whose every stake landed at the last second has zero weight: split the pot by principal
        uint256 share = totalWeight == 0
            ? pot * principal / (yesWon ? m.yesPool : m.noPool)
            : pot * weight / totalWeight;
        fee = share * feeBpsOf(who) / 10_000;
        amount = principal + share - fee;
    }

    /// @notice What `who` can take out of a resolved market, after the fee.
    function payout(uint256 id, address who) external view returns (uint256 amount) {
        (amount,) = payoutAndFee(id, who);
    }

    function claim(uint256 id) external nonReentrant {
        (uint256 amount, uint256 fee) = payoutAndFee(id, msg.sender);
        if (amount == 0) revert NothingToClaim();
        _positions[id][msg.sender].claimed = true;
        emit Claimed(id, msg.sender, amount);
        if (fee > 0) {
            emit FeeTaken(id, fee);
            _send(treasury, fee);
        }
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function market(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function position(uint256 id, address who) external view returns (Position memory) {
        return _positions[id][who];
    }

    /// @notice Implied probability of YES in basis points, read straight from the pools (no weighting).
    function impliedYesBps(uint256 id) external view returns (uint256) {
        Market storage m = _markets[id];
        uint256 total = uint256(m.yesPool) + m.noPool;
        return total == 0 ? 0 : uint256(m.yesPool) * 10_000 / total;
    }

    // ------------------------------------------------------------------ internals

    function _phase(address token) private view returns (uint8) {
        IPonsV2LaunchFactory.LaunchedToken memory l = factory.getLaunchedToken(token);
        if (!l.exists) revert NotALaunch();
        return l.phase;
    }

    function _requireOnCurve(address token) private view {
        if (_phase(token) != 0) revert AlreadyGraduated();
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    // the Pons launcher token is a plain OpenZeppelin ERC-20 that returns true; a token that returns nothing
    // is accepted too, one that returns false is not
    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(zolt).call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(zolt).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
