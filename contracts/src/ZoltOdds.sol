// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The slice of Pons V2's launch factory that a market needs: whether a token is one of its launches
///         and whether that launch has left the bonding curve. Layout mirrors the verified contract on chain
///         4663 (Sourcify exact match, 0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e).
interface IPonsV2LaunchFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase; // 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

/// @title Zolt Odds
/// @notice Yes/No markets on whether a freshly launched Pons V2 token reaches its graduation threshold before a
///         deadline. Resolution is read from the factory's own state: the launch phase leaves NotGraduated the
///         instant a buy crosses the threshold, and only the factory can move it. No oracle, no committee, no
///         owner.
///
///         Parimutuel: every stake goes into its side's pool; at resolution the losing pool, minus a 1% fee, is
///         split among the winning side in proportion to time-weighted stakes. A stake placed a second before
///         staking closes carries almost no weight, so late, near-certain money cannot dilute early money.
///
///         Resolution is by witness. YES can be recorded by anyone while the deadline has not passed and the
///         launch has graduated. NO can be recorded by anyone once the deadline has passed and the launch has
///         not. A graduation that lands after the deadline but before anyone records NO leaves the market
///         unobservable; a day later anyone can void it and every stake is refunded.
contract ZoltOdds {
    // ------------------------------------------------------------------ types

    enum Outcome {
        Open,
        Yes,
        No,
        Void
    }

    struct Market {
        address token;
        uint40 openedAt;
        uint40 closesAt; // no stakes after this
        uint40 deadline; // graduation must be witnessed on or before this
        uint8 window; // index into WINDOWS
        Outcome outcome;
        uint128 yesPool;
        uint128 noPool;
        uint256 yesWeight;
        uint256 noWeight;
    }

    struct Position {
        uint128 yes;
        uint128 no;
        uint256 yesWeight;
        uint256 noWeight;
        bool claimed;
    }

    // ------------------------------------------------------------------ constants

    uint256 public constant FEE_BPS = 100; // 1% of the losing pool
    uint256 public constant VOID_AFTER = 1 days;
    uint256 public constant MIN_STAKE = 0.0001 ether;
    uint8 public constant WINDOW_COUNT = 3;

    // ------------------------------------------------------------------ state

    IPonsV2LaunchFactory public immutable factory;
    address public immutable treasury;

    Market[] private _markets;
    mapping(address token => mapping(uint8 window => uint256 idPlusOne)) public openMarket;
    mapping(uint256 id => mapping(address who => Position)) private _positions;

    uint256 private _lock;

    // ------------------------------------------------------------------ events

    event MarketOpened(uint256 indexed id, address indexed token, uint8 window, uint40 closesAt, uint40 deadline);
    event Staked(uint256 indexed id, address indexed who, bool yes, uint256 amount, uint256 weight);
    event Resolved(uint256 indexed id, Outcome outcome, address indexed by);
    event Claimed(uint256 indexed id, address indexed who, uint256 amount);
    event FeeTaken(uint256 indexed id, uint256 amount);

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

    constructor(IPonsV2LaunchFactory factory_, address treasury_) {
        require(address(factory_) != address(0) && treasury_ != address(0), "zero");
        factory = factory_;
        treasury = treasury_;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
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
                noWeight: 0
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
    function witnessYes(uint256 id) external {
        Market storage m = _markets[id];
        if (m.outcome != Outcome.Open) revert NotOpen();
        if (block.timestamp > m.deadline) revert TooLate();
        if (_phase(m.token) == 0) revert StillOnCurve();
        _resolve(id, m, Outcome.Yes);
    }

    /// @notice Record that the deadline passed with the launch still on its curve. Anyone may call it.
    function witnessNo(uint256 id) external {
        Market storage m = _markets[id];
        if (m.outcome != Outcome.Open) revert NotOpen();
        if (block.timestamp <= m.deadline) revert TooEarly();
        if (_phase(m.token) != 0) revert AlreadyGraduated();
        _resolve(id, m, Outcome.No);
    }

    /// @notice A market nobody could witness either way (it graduated after the deadline, before anyone recorded
    ///         NO) is voided a day after its deadline and every stake is refunded.
    function voidUnobserved(uint256 id) external {
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

        if (o == Outcome.Yes || o == Outcome.No) {
            uint256 losing = o == Outcome.Yes ? m.noPool : m.yesPool;
            uint256 fee = losing * FEE_BPS / 10_000;
            if (fee > 0) {
                emit FeeTaken(id, fee);
                _send(treasury, fee);
            }
        }
    }

    // ------------------------------------------------------------------ claim

    /// @notice What `who` can take out of a resolved market: principal plus a weighted share of the losing pool
    ///         for winners, principal back for a void market, nothing for losers.
    function payout(uint256 id, address who) public view returns (uint256 amount) {
        Market storage m = _markets[id];
        Position storage p = _positions[id][who];
        if (m.outcome == Outcome.Open || p.claimed) return 0;
        if (m.outcome == Outcome.Void) return uint256(p.yes) + p.no;

        bool yesWon = m.outcome == Outcome.Yes;
        uint256 principal = yesWon ? p.yes : p.no;
        uint256 weight = yesWon ? p.yesWeight : p.noWeight;
        uint256 totalWeight = yesWon ? m.yesWeight : m.noWeight;
        uint256 losing = yesWon ? m.noPool : m.yesPool;
        uint256 pot = losing - losing * FEE_BPS / 10_000;
        if (principal == 0) return 0;
        // a winning side whose every stake landed at the last second has zero weight: split the pot by principal
        uint256 share = totalWeight == 0
            ? pot * principal / (yesWon ? m.yesPool : m.noPool)
            : pot * weight / totalWeight;
        return principal + share;
    }

    function claim(uint256 id) external nonReentrant {
        uint256 amount = payout(id, msg.sender);
        if (amount == 0) revert NothingToClaim();
        _positions[id][msg.sender].claimed = true;
        emit Claimed(id, msg.sender, amount);
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
}
