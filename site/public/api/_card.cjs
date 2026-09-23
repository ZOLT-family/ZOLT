// The link-preview card as a tree of plain elements for satori (@vercel/og): the same paper, bands, spine, type and
// palette as the page, at 1200x630. Two kinds: the site card (the base rate) and a market card (one market's pools).
// Underscore-prefixed, so Vercel does not deploy it as a function; card.js imports it.
const C = { paper: '#E6EBE2', band: '#DBE4D5', ink: '#11171A', ink2: '#4A5852', line: 'rgba(17,23,26,.16)', hot: '#D2401F', teal: '#0E5A50', amber: '#B9861F' };
const W = 1200, H = 630, ROW = 42;

const el = (type, style, children, extra) => ({ type, props: Object.assign({ style, children }, extra || {}) });
const text = (s, style) => el('div', Object.assign({ display: 'flex' }, style), String(s));

function paper() {
  const bands = [];
  for (let y = 0, i = 0; y < H; y += ROW, i++) {
    bands.push(el('div', { position: 'absolute', left: 0, top: y, width: W, height: ROW, backgroundColor: i % 2 ? C.band : 'transparent', borderTop: '1px solid ' + C.line, display: 'flex' }));
  }
  return bands;
}

function frame(children, spineText) {
  return el('div', { width: W, height: H, display: 'flex', position: 'relative', backgroundColor: C.paper, fontFamily: 'Anybody', color: C.ink }, [
    ...paper(),
    el('div', { position: 'absolute', left: 84, top: 0, width: 2, height: H, backgroundColor: C.ink, display: 'flex' }),
    el('div', { position: 'absolute', left: -230, top: 300, width: 560, display: 'flex', justifyContent: 'flex-end', transform: 'rotate(-90deg)', fontFamily: 'Fragment Mono', fontSize: 18, letterSpacing: 2, color: C.ink }, spineText),
    el('div', { position: 'absolute', left: 130, top: 0, width: W - 190, height: H, display: 'flex', flexDirection: 'column' }, children),
  ]);
}

function stat(value, label, color) {
  return el('div', { display: 'flex', flexDirection: 'column', width: 300, borderTop: '1px solid ' + C.line, paddingTop: 12 }, [
    text(value, { fontFamily: 'Anybody', fontSize: 64, fontWeight: 800, color: color || C.ink, lineHeight: 1 }),
    text(label.toUpperCase(), { fontFamily: 'Fragment Mono', fontSize: 17, letterSpacing: 1, marginTop: 10, color: C.ink }),
  ]);
}

function stamp(label) {
  return el('div', { position: 'absolute', right: 30, top: 70, transform: 'rotate(-5deg)', border: '3px solid ' + C.hot, color: C.hot, padding: '10px 22px', fontFamily: 'Anybody', fontSize: 22, fontWeight: 800, letterSpacing: 1, display: 'flex' }, label);
}

function foot(left, right) {
  return el('div', { position: 'absolute', left: 0, bottom: 40, width: W - 190, display: 'flex', justifyContent: 'space-between', fontFamily: 'Fragment Mono', fontSize: 22, color: C.ink }, [text(left), text(right)]);
}

// the site card: the base rate the page leads with
function siteCard(f, site) {
  return frame([
    text('§ 01  THE BOARD', { fontFamily: 'Fragment Mono', fontSize: 20, color: C.hot, marginTop: 58 }),
    text('Yes / No on whether a launch graduates in time', { fontFamily: 'Fragment Mono', fontSize: 20, marginTop: 6 }),
    text('Will it graduate?', { fontFamily: 'Gloock', fontSize: 128, lineHeight: 1, marginTop: 26, marginLeft: -6 }),
    text('The first launch odds market on Robinhood Chain.', { fontFamily: 'Anybody', fontSize: 33, color: C.teal, marginTop: 10 }),
    el('div', { display: 'flex', flexDirection: 'row', marginTop: 54, gap: 30 }, [
      stat(f.launches24h, 'launches a day'),
      stat(f.gradRate24h, 'reach the threshold', C.teal),
      stat(f.gradMedian, 'median time to graduate'),
    ]),
    stamp('SETTLED BY THE CHAIN'),
    foot(site.replace(/^https?:\/\//, '').replace(/\/$/, ''), 'parimutuel · 1% fee · no oracle'),
  ], 'ZOLT ODDS  ·  ROBINHOOD CHAIN 4663');
}

// Gloock at 118px fits about 17 characters across the card; longer headlines step down
function headlineSize(s) {
  const n = s.length;
  return n <= 17 ? 118 : n <= 20 ? 100 : n <= 24 ? 84 : n <= 30 ? 68 : 56;
}

function fmtSecs(s) {
  if (s <= 0) return 'now';
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  return Math.round(s / 3600) + ' h';
}

// a market card: one market's pools and clock
function marketCard(m, site) {
  const name = m.symbol && m.symbol !== '?' ? '$' + m.symbol : m.token.slice(0, 6) + '…' + m.token.slice(-4);
  const open = m.outcome === 'open';
  const implied = m.impliedYesBps === null ? '—' : (m.impliedYesBps / 100).toFixed(1) + '%';
  const clock = open
    ? (m.stakingOpen ? 'staking closes in ' + fmtSecs(m.secondsToClose) : 'deadline in ' + fmtSecs(m.secondsToDeadline))
    : 'resolved ' + m.outcome.toUpperCase();
  const label = open ? (m.stakingOpen ? 'STAKING OPEN' : 'WAITING ON THE DEADLINE') : 'RESOLVED ' + m.outcome.toUpperCase();
  return frame([
    text('§ 01  THE BOARD  ·  MARKET #' + m.id, { fontFamily: 'Fragment Mono', fontSize: 20, color: C.hot, marginTop: 58 }),
    text('A Pons launch, a ' + m.windowLabel + ' window, settled by the chain', { fontFamily: 'Fragment Mono', fontSize: 20, marginTop: 6 }),
    // one line, always: the size steps down with the name, and a very long one is cut with an ellipsis
    text('Will ' + name + ' graduate?', { fontFamily: 'Gloock', fontSize: headlineSize('Will ' + name + ' graduate?'), lineHeight: 1, marginTop: 26, marginLeft: -6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: W - 190 }),
    text('In ' + m.windowLabel + ' · ' + clock + '.', { fontFamily: 'Anybody', fontSize: 33, color: C.teal, marginTop: 10 }),
    el('div', { display: 'flex', flexDirection: 'row', marginTop: 54, gap: 30 }, [
      stat(Number(m.yesPool).toFixed(3), 'ETH on yes', C.hot),
      stat(Number(m.noPool).toFixed(3), 'ETH on no', C.teal),
      stat(implied, 'implied yes'),
    ]),
    stamp(label),
    foot(site.replace(/^https?:\/\//, '').replace(/\/$/, '') + '/m/' + m.id, 'stake from any wallet · no oracle'),
  ], 'ZOLT ODDS  ·  ROBINHOOD CHAIN 4663');
}

module.exports = { siteCard, marketCard, W, H };
