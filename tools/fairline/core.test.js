#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_fairline_core.js — the bucketing, the labels and the words.

   The decisions are supabase/fairline.sql's; this module mirrors its rules,
   read from the same rules object the database returns (fairline_rules()),
   so the page can explain a label without deciding one. Checked here, in
   Node, with the rules parsed from the SQL file itself:

     * the odds, lead-time and stake buckets at every boundary
     * the four labels, the minimum sample, P/L only without closes
     * every slice has a name, and the names say the rules' own numbers
     * the verdict sentences: the user's own example, word for word in shape
     * a small sample, a P/L-only slice and the free teaser say no more than
       they know
     * The Board's words: fair as probability and odds, best price and book,
       edge, age, stale, Kalshi only when OK, no number for DK Predictions

   (tools/fairline/fairline_sql.test.js runs these same mirrors against the
   SQL functions on a grid of cases.)
   Run: node tools/fairline/core.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_fairline_core.js'));
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'fairline.sql'), 'utf8');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }

/* the rules, as fairline_rules() builds them */
function buckets(name) {
  const m = new RegExp("'" + name + "', jsonb_build_array\\(([\\s\\S]*?)\\)\\),").exec(SQL);
  if (!m) return [];
  return [...m[1].matchAll(/jsonb_build_object\('key', '(\w+)',\s*'from', (-?[\d.]+|null),\s*'to', (-?[\d.]+|null)\)?/g)]
    .map((x) => ({ key: x[1], from: x[2] === 'null' ? null : Number(x[2]), to: x[3] === 'null' ? null : Number(x[3]) }));
}
const R = {
  min_sample_bets: Number((/'min_sample_bets',\s*(\d+)/.exec(SQL) || [])[1]),
  min_clv_bets: Number((/'min_clv_bets',\s*(\d+)/.exec(SQL) || [])[1]),
  odds_buckets: buckets('odds_buckets'), lead_buckets: buckets('lead_buckets'), stake_buckets: buckets('stake_buckets')
};
chk('(the rules parse from fairline.sql: 15 / 15, five odds ranges, four lead ranges, four stake ranges)', R.min_sample_bets === 15 && R.min_clv_bets === 15 &&
  R.odds_buckets.length === 5 && R.lead_buckets.length === 4 && R.stake_buckets.length === 4, R);

/* ── buckets ───────────────────────────────────────────────────────────── */
const ob = (a) => C.oddsBucket(a, R);
chk('odds: -200 and shorter', ob(-200) === 'le_m200' && ob(-5000) === 'le_m200');
chk('odds: -199 to -121', ob(-199) === 'm199_m121' && ob(-150) === 'm199_m121' && ob(-121) === 'm199_m121');
chk('odds: -120 to +120 (and -100 / +100 are one price)', ob(-120) === 'm120_p120' && ob(-110) === 'm120_p120' && ob(-100) === 'm120_p120' && ob(100) === 'm120_p120' && ob(120) === 'm120_p120');
chk('odds: +121 to +200', ob(121) === 'p121_p200' && ob(200) === 'p121_p200');
chk('odds: longer than +200', ob(201) === 'gt_p200' && ob(1000) === 'gt_p200');
chk('odds are rounded first (-120.4 is -120)', ob(-120.4) === 'm120_p120' && ob(-120.6) === 'm199_m121');
chk('not odds, no range', ob(50) === null && ob(null) === null && ob('x') === null);
const t0 = '2026-11-01T18:00:00Z', ago = (h) => new Date(Date.parse(t0) - h * 3600000).toISOString();
const lb = (h) => C.leadBucket(ago(h), t0, R);
chk('lead: 48h+ / 24-48h / 6-24h / under 6h at the boundaries', lb(48) === '48h_plus' && lb(47.99) === '24_48h' && lb(24) === '24_48h' && lb(23.99) === '6_24h' &&
  lb(6) === '6_24h' && lb(5.99) === 'under_6h' && lb(0.01) === 'under_6h');
chk('lead: at or after the start is live; no start is unknown', lb(0) === 'live' && lb(-1) === 'live' && C.leadBucket(ago(3), null, R) === 'unknown');
const sb = (x) => C.stakeBucket(x, R);
chk('stake vs median: small < 0.75 <= typical < 1.25 <= large < 2 <= oversized', sb(0.5) === 'small' && sb(0.75) === 'typical' && sb(1.249) === 'typical' &&
  sb(1.25) === 'large' && sb(2) === 'oversized' && sb(9) === 'oversized' && sb(null) === 'unknown');

/* ── the labels ────────────────────────────────────────────────────────── */
const cl = (b, c, r, v) => C.classify(b, c, r, v, R);
chk('real leak: losing, not beating the close', cl(40, 40, -0.12, -1.4) === 'real_leak');
chk('bad luck: losing, beating the close', cl(40, 40, -0.12, 1.4) === 'bad_luck');
chk('running hot: winning, the close beating you', cl(40, 40, 0.12, -1.4) === 'running_hot');
chk('real edge: winning, beating the close', cl(40, 40, 0.12, 1.4) === 'real_edge');
chk('below the minimum sample: no label at all', cl(14, 14, -0.5, -3) === null && cl(15, 15, -0.5, -3) === 'real_leak');
chk('too few captured closes: P/L only', cl(30, 14, -0.1, -2) === 'losing' && cl(30, 0, 0.1, null) === 'winning');
chk('exactly zero: a zero CLV is not beating the close, a zero return is not losing', cl(20, 20, -0.1, 0) === 'real_leak' && cl(20, 20, 0, 1) === 'real_edge');
chk('without the rules, nothing is decided', C.classify(40, 40, -0.1, -1, {}) === null);
chk('every label the SQL can return has a chip with words', ['real_leak', 'bad_luck', 'running_hot', 'real_edge', 'losing', 'winning'].every((k) => C.LABELS[k] && C.LABELS[k].chip.length > 3) &&
  [...SQL.matchAll(/then '(real_leak|bad_luck|running_hot|real_edge|losing|winning)'/g)].every((m) => !!C.LABELS[m[1]]));
chk('the P/L-only chips say so', /P\/L only/.test(C.LABELS.losing.chip) && /P\/L only/.test(C.LABELS.winning.chip));
chk('a small sample is a chip too', C.labelView({ small_sample: true, label: null }).chip === 'Small sample');

/* ── slice names ───────────────────────────────────────────────────────── */
chk('every odds range is named by the rules\' own numbers', R.odds_buckets.map((b) => C.sliceName('odds', b.key, R)).join(' | ') ===
  'Odds −200 or shorter | Odds −199 to −121 | Odds −120 to +120 | Odds +121 to +200 | Odds longer than +200');
chk('every lead time is named', ['48h_plus', '24_48h', '6_24h', 'under_6h', 'live', 'unknown'].map((k) => C.sliceName('lead', k, R)).join(' | ') ===
  'Bet 48h+ before the start | Bet 24–48h before the start | Bet 6–24h before the start | Bet under 6h before the start | Live bets | Start time unknown');
chk('every stake size is named against the median', /under 0\.75× your median/.test(C.sliceName('stake', 'small', R)) && /2× your median or more/.test(C.sliceName('stake', 'oversized', R)));
chk('markets and bet types', C.sliceName('market', 'props') === 'Props' && C.sliceName('market', 'spread') === 'Spreads' && C.sliceName('bet_type', 'parlay') === 'Parlays');
chk('sports: short names stay short, long ones read as words', C.sliceName('sport', 'NFL') === 'NFL' && C.sliceName('sport', 'SOCCER') === 'Soccer');
chk('books by their own name', C.sliceName('book', 'DraftKings') === 'DraftKings');
chk('every dimension the SQL slices by has a heading', ['market', 'sport', 'bet_type', 'odds', 'lead', 'book', 'stake'].every((d) => C.DIMS.some((x) => x.key === d)) &&
  /\('sport', bx\.sport\), \('market', bx\.market\), \('bet_type', bx\.bet_type\),\s*\('odds', bx\.odds_b\), \('lead', bx\.lead_b\), \('book', bx\.platform\), \('stake', bx\.stake_b\)/.test(SQL));

/* ── verdicts ──────────────────────────────────────────────────────────── */
const props = { dim: 'market', val: 'props', bets: 40, wins: 15, losses: 25, label: 'real_leak', small_sample: false, roi_basis: 'dollars', pl_dollars: -395, avg_clv_pct: -1.4, clv_bets: 40 };
chk('the example, exactly: "Props: down $395 over 40 bets, and you\'re not beating the close. This one\'s real."',
  C.verdict(props, R) === 'Props: down $395 over 40 bets, and you’re not beating the close. This one’s real.', C.verdict(props, R));
chk('bad luck says variance', /^NFL: down \$120 over 22 bets, but you’re beating the close \(\+1\.8% average CLV\)\. That’s variance, not a leak\.$/.test(
  C.verdict({ dim: 'sport', val: 'NFL', bets: 22, label: 'bad_luck', roi_basis: 'dollars', pl_dollars: -120, avg_clv_pct: 1.8 }, R)));
chk('running hot warns', /up \$300 over 30 bets, but the close is beating you .* Don’t count on it lasting\.$/.test(
  C.verdict({ dim: 'market', val: 'moneyline', bets: 30, label: 'running_hot', roi_basis: 'dollars', pl_dollars: 300, avg_clv_pct: -0.9 }, R)));
chk('real edge', /up \$210 over 25 bets, and you’re beating the close .* This one’s real\.$/.test(
  C.verdict({ dim: 'market', val: 'total', bets: 25, label: 'real_edge', roi_basis: 'dollars', pl_dollars: 210, avg_clv_pct: 1.1 }, R)));
chk('units when the slice has no dollars', /^Spreads: down 5\.45 units over 15 bets/.test(C.verdict({ dim: 'market', val: 'spread', bets: 15, label: 'real_leak', roi_basis: 'units', pl_units: -5.45 }, R)));
chk('flat units say they are flat', /one unit a bet/.test(C.verdict({ dim: 'market', val: 'spread', bets: 15, label: 'losing', roi_basis: 'flat', pl_basis_value: -2.1 }, R)));
const small = C.verdict({ dim: 'market', val: 'parlay', bets: 6, label: null, small_sample: true, roi_basis: 'dollars', pl_dollars: -60 }, R);
chk('a small sample says so, and carries no money and no verdict', small === 'Parlays: 6 bets settled. Too few to read yet — a label needs 15.' && !/\$/.test(small), small);
const plo = C.verdict({ dim: 'market', val: 'props', bets: 18, label: 'losing', roi_basis: 'dollars', pl_dollars: -80, clv_bets: 0 }, R);
chk('P/L only says it cannot tell the bets from luck, and claims nothing about the close', /Too few captured closes/.test(plo) && !/beating the close/.test(plo), plo);
chk('no settled bets: said plainly', C.verdict({ dim: 'sport', val: 'NBA', bets: 0 }, R) === 'NBA: no settled bets yet.');

/* ── the numbers under a verdict ───────────────────────────────────────── */
const nl = C.numbersLine(Object.assign({}, props, { pending: 2, pushes: 1, cashouts: 1, dollars_bets: 40, units_bets: 30, pl_units: -7.9, roi_pct: -19.8, beat_close: 14, beat_close_pct: 35 }));
const g = (k) => (nl.find((x) => x.k === k) || {}).v;
chk('bets with the open ones beside them', g('Bets') === '40 (+2 open)');
chk('the record with pushes and cash-outs', g('Record') === '15–25–1 · 1 cashed out');
chk('dollars signed; units say when they cover only part of the slice', g('Dollars') === '−$395' && g('Units') === '−7.90u (30 of 40 bets)');
chk('ROI, CLV and beat-close rate', g('ROI') === '−19.8%' && g('Avg CLV') === '−1.40% (40 closes)' && g('Beat close') === '35% (14 of 40)');
chk('no close captured: said, not zero', (C.numbersLine({ bets: 16, clv_bets: 0 }).find((x) => x.k === 'Avg CLV') || {}).v === 'No close captured');

/* ── the free teaser ───────────────────────────────────────────────────── */
chk('free: the slice name only', C.teaserLine({ state: 'leak', dim: 'market', val: 'props' }, R) === 'Your biggest leak is in Props.');
chk('free: no leak, or not enough bets, said plainly', /No real leak/.test(C.teaserLine({ state: 'no_leak' }, R)) && /Not enough settled bets/.test(C.teaserLine({ state: 'not_enough_bets' }, R)));

/* ── The Board's words ─────────────────────────────────────────────────── */
const row = { sig_key: 'k', sport: 'NFL', market: 'spread', selection: 'Kansas City Chiefs', point: -3.5, home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills',
  fair_prob: 0.52, fair_american: -108, best_dec: 2.04, best_american: 104, best_book: 'DraftKings', edge_pts: 2.98, quote_age_min: 3.5, fresh_limit_min: 120, fresh: true,
  kalshi_state: null };
const v = C.boardRow(row);
chk('a row: the side as a reader names it, the game, the league and market', v.side === 'Kansas City Chiefs −3.5' && v.game === 'Buffalo Bills at Kansas City Chiefs' && v.league === 'NFL · Spread');
chk('fair as a probability and as fair odds', v.fairProb === '52.0%' && v.fairOdds === 'fair −108');
chk('the best price and its book; the edge, signed, in points; the age', v.best === '+104' && v.book === 'DraftKings' && v.edge === '+2.98 pts' && v.edgeCls === 'pos' && v.age === '4 min');
const st = C.boardRow(Object.assign({}, row, { fresh: false, quote_age_min: 185 }));
chk('a stale row says why, in words', st.stale === true && st.staleWhy === 'Older than its 2 h limit' && st.age === '3 h 5 min');
const np = C.boardRow(Object.assign({}, row, { best_dec: null, best_american: null, best_book: null, edge_pts: null, fresh: false }));
chk('no price captured: said, and no edge', np.best === 'No price captured' && np.edge === '—' && np.staleWhy === 'No price captured');
chk('Kalshi OK: its mid in cents, its ask beside it', C.kalshiWords({ kalshi_state: 'OK', kalshi_mid: 0.6, kalshi_ask: 0.615 }).text === '60¢' &&
  C.kalshiWords({ kalshi_state: 'OK', kalshi_mid: 0.6, kalshi_ask: 0.615 }).sub === 'ask 61.5¢');
chk('Kalshi not OK: its state, no price; not linked: a dash', C.kalshiWords({ kalshi_state: 'STALE', kalshi_mid: 0.6 }).text === 'Stale' &&
  C.kalshiWords({ kalshi_state: null }).text === '—');
chk('the row view has no field for DK Predictions (no feed, no number)', !Object.keys(v).some((k) => /dk/i.test(k)));
chk('a total and a moneyline read as a bettor writes them', C.sideWords({ market: 'total', selection: 'Over', point: 47.5 }) === 'Over 47.5' &&
  C.sideWords({ market: 'moneyline', selection: 'Buffalo Bills' }) === 'Buffalo Bills ML');
chk('money: whole dollars from $100, cents below', C.fmtMoney(-395.4) === '−$395' && C.fmtMoney(45.46, true) === '+$45.46' && C.fmtMoney(1234.5) === '$1,235');

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'fairline core — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
