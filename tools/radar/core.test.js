#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_radar.js — the grading core, on worked examples. Offline.

     rules      nothing runs without the rules (radar_rules() is the constant;
                these tests use the copy frozen in the H-RADAR-01 registration)
     times      every way Polymarket writes a time
     bets       a bet is a position whose FIRST buy came before the start;
                entry = the pregame VWAP; profit from every trade + settlement
     CLV        close - entry, and close / entry - 1 (the house formula)
     follow     the price 5 (and 15) minutes after the entry, never older
                than 10 minutes, never after the start; ROI = settle / p - 1
     conviction a stake against the wallet's median stake
     style      Market Maker / Hedger / Directional, at the boundaries
     grade      the sample rule (50), ROI, the Radar Score and its shrinkage,
                the top 25 directional wallets
     bootstrap  deterministic for a seed; whole games resampled
     holdout    the three registered criteria, each able to fail alone
     matching   a market to exactly one game, or a reason

   Every expected number below is worked out by hand in its comment.
   Run: node tools/radar/core.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'edgedesk_radar.js'));
const REG = require(path.join(ROOT, 'research', 'radar', 'registration_h_radar_01.json'));
const RULES = REG.spec.rules;
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-9);
const MIN = 60000, H = 3600000;

/* ── the rules ───────────────────────────────────────────────────────── */
chk('nothing runs without the rules', (() => { try { R.buildBets([], {}, null); return false; } catch (e) { return /rules are required/.test(e.message); } })());
chk('a missing rule is named', (() => { try { R.rules(Object.assign({}, RULES, { min_graded: undefined })); return false; } catch (e) { return /missing min_graded/.test(e.message); } })());
chk('the registration carries every rule the core reads', R.RULE_KEYS.every((k) => RULES[k] !== undefined), R.RULE_KEYS.filter((k) => RULES[k] === undefined));

/* ── times ───────────────────────────────────────────────────────────── */
const T0 = Date.parse('2026-10-30T00:15:00Z');
chk('epoch seconds', R.ms(T0 / 1000) === T0);
chk('epoch ms', R.ms(T0) === T0);
chk('a numeric string of seconds', R.ms(String(T0 / 1000)) === T0);
chk('ISO', R.ms('2026-10-30T00:15:00Z') === T0);
chk('Gamma\'s "2026-10-30 00:15:00+00"', R.ms('2026-10-30 00:15:00+00') === T0);
chk('an offset with no colon', R.ms('2026-10-29 20:15:00-0400') === T0);
chk('nothing is not a time', R.ms('') === null && R.ms(null) === null && R.ms('soon') === null);

/* ── the world: one NFL moneyline, kickoff T0 ────────────────────────── */
const W = '0x' + 'a'.repeat(40), W2 = '0x' + 'b'.repeat(40);
const C1 = '0x' + '1'.repeat(64), C2 = '0x' + '2'.repeat(64), C3 = '0x' + '3'.repeat(64);
let txn = 0;
const tx = () => '0x' + (++txn).toString(16).padStart(64, '0');
const trade = (w, cond, token, oi, side, size, price, at) => ({ wallet: w, kind: 'TRADE', tx_hash: tx(), ts: at, condition_id: cond, token_id: token, outcome_index: oi, side, size, price, usdc: size * price });
const mkt = (cond, o) => Object.assign({ condition_id: cond, league: 'nfl', market_type: 'moneyline', outcomes: ['Chiefs', 'Raiders'], token_ids: [cond + ':0', cond + ':1'],
  game_start_at: T0, closed: true, settle: [1, 0], event_slug: 'nfl-kc-lv-2026-10-29', event_ref: 'ev-' + cond.slice(2, 6), line: null, question: 'Chiefs vs. Raiders' }, o || {});
const MK = { [C1]: mkt(C1), [C2]: mkt(C2, { settle: [0, 1], event_ref: 'ev-2' }), [C3]: mkt(C3, { league: 'epl' }) };

/* entry: 100 @ 0.40 at T0-3h, 50 @ 0.46 at T0-2h (pregame); 30 @ 0.70 in play; sells 40 @ 0.80 in play.
   pregame VWAP = (40 + 23) / 150 = 0.42; stake 63; buy cost 63 + 21 = 84;
   held = 180 - 40 = 140; settle 1: profit = 32 + 140 - 84 = 88 */
const tr = [
  trade(W, C1, C1 + ':0', 0, 'BUY', 100, 0.40, T0 - 3 * H),
  trade(W, C1, C1 + ':0', 0, 'BUY', 50, 0.46, T0 - 2 * H),
  trade(W, C1, C1 + ':0', 0, 'BUY', 30, 0.70, T0 + 30 * MIN),
  trade(W, C1, C1 + ':0', 0, 'SELL', 40, 0.80, T0 + 60 * MIN),
  trade(W, C2, C2 + ':0', 0, 'BUY', 20, 0.55, T0 + 10 * MIN),          /* in-play entry: not a bet */
  trade(W, C3, C3 + ':0', 0, 'BUY', 20, 0.55, T0 - 10 * MIN)           /* not a covered league */
];
const built = R.buildBets(tr, MK, RULES);
const b1 = built.bets.find((b) => b.condition_id === C1);
chk('one bet: the covered pregame entry', built.bets.length === 1 && !!b1, built);
chk('an in-play entry is not a bet, and is counted', built.skipped.in_play_entry === 1);
chk('another league is not covered, and is counted', built.skipped.not_covered === 1);
chk('entry = first BUY time', b1.entry_at === T0 - 3 * H);
chk('entry price = the pregame VWAP (63 / 150 = 0.42)', near(b1.entry_price, 0.42));
chk('stake = the pregame cost (63)', near(b1.stake, 63));
chk('buy cost counts every buy (84)', near(b1.buy_cost, 84));
chk('profit = 32 proceeds + 140 held x 1 - 84 = 88', near(b1.profit, 88), b1.profit);
chk('a win, settled at 1', b1.result === 'win' && b1.settle === 1);
chk('every trade\'s transaction hash is kept (4)', b1.txs.length === 4 && b1.txs.every((h) => /^0x[0-9a-f]{64}$/.test(h)) && b1.entry_tx === b1.txs[0]);
{
  const sm = R.buildBets([trade(W, C1, C1 + ':0', 0, 'BUY', 10, 0.5, T0 - H), { wallet: W, kind: 'SPLIT', tx_hash: tx(), ts: T0 - H, condition_id: C1 }], MK, RULES);
  chk('a split or merge on the market makes its cost unattributable: not a bet, counted', sm.bets.length === 0 && sm.skipped.split_merge === 1);
  const oversold = R.buildBets([trade(W, C1, C1 + ':0', 0, 'BUY', 10, 0.5, T0 - H), trade(W, C1, C1 + ':0', 0, 'SELL', 15, 0.5, T0 - 30 * MIN)], MK, RULES);
  chk('selling more than was bought (history missing) is not graded', oversold.bets.length === 0 && oversold.skipped.sold_more_than_bought === 1);
  const open = R.buildBets([trade(W, C1, C1 + ':0', 0, 'BUY', 10, 0.5, T0 - H)], { [C1]: mkt(C1, { closed: false, settle: null }) }, RULES);
  chk('an unresolved market: the bet is open, no profit', open.bets[0].result === 'open' && open.bets[0].profit === null);
  const push = R.buildBets([trade(W, C1, C1 + ':0', 0, 'BUY', 10, 0.4, T0 - H)], { [C1]: mkt(C1, { settle: [0.5, 0.5] }) }, RULES);
  chk('a 50-50 resolution is a push: 10 x 0.5 - 4 = +1', push.bets[0].result === 'push' && near(push.bets[0].profit, 1));
}

/* ── CLV and the follow ──────────────────────────────────────────────── */
/* a price every minute from T0-4h: 0.40 until T0-3h+3m, then 0.44 until T0-2h, then 0.50 to the start */
const hist = [];
for (let t = T0 - 4 * H; t <= T0 + 10 * MIN; t += MIN) hist.push({ t, p: t < T0 - 3 * H + 3 * MIN ? 0.40 : t < T0 - 2 * H ? 0.44 : 0.50 });
chk('priceAt: the last point at or before t', R.priceAt(hist, T0 - 3 * H + 5 * MIN, 10 * MIN).p === 0.44);
chk('priceAt: none older than the gap', R.priceAt([{ t: T0 - 30 * MIN, p: 0.5 }], T0, 10 * MIN) === null);
chk('priceAt: none before the first point', R.priceAt(hist, T0 - 5 * H, null) === null);
const g1 = R.gradeBet(b1, hist, RULES);
chk('close = the last price at or before the start (0.50)', g1.close_price === 0.50 && g1.close_at === T0);
chk('CLV = 0.50 - 0.42 = +8.0 pp', near(g1.clv_pp, 8));
chk('CLV% = 0.50 / 0.42 - 1 (the house formula: entryDec x closeFair - 1)', near(g1.clv_pct, 0.5 / 0.42 - 1, 1e-6));
chk('follow 5 min after the entry: 0.44 (the price had moved by then)', g1.follow5_price === 0.44 && g1.follow5_at === T0 - 3 * H + 5 * MIN);
chk('follow ROI (5) = 1 / 0.44 - 1', near(g1.follow5_roi, 1 / 0.44 - 1, 1e-6));
chk('follow 15 min: 0.44, ROI the same', g1.follow15_price === 0.44 && near(g1.follow15_roi, 1 / 0.44 - 1, 1e-6));
chk('the follower beat the close: 0.50 > 0.44', g1.beat_close5 === true);
{
  const late = R.gradeBet(Object.assign({}, b1, { entry_at: T0 - 3 * MIN }), hist, RULES);
  chk('an entry 3 minutes before the start: no 5-minute follow (the game had started), reason kept', late.follow5_price === null && late.follow5_reason === 'started_before_follow' && late.follow5_roi === null);
  const sparse = R.gradeBet(b1, [{ t: T0 - 4 * H, p: 0.4 }, { t: T0 - 30 * MIN, p: 0.5 }], RULES);
  chk('no price within 10 minutes of the follow moment: no follow price', sparse.follow5_price === null && sparse.follow5_reason === 'no_price_near_follow');
  chk('…but a close 30 minutes before the start is within 60: graded', sparse.close_price === 0.5);
  const noClose = R.gradeBet(b1, hist.filter((x) => x.t <= T0 - 2 * H), RULES);
  chk('the last price 2 hours before the start is no close (over 60 minutes)', noClose.close_price === null && noClose.clv_pp === null);
  const loss = R.gradeBet(Object.assign({}, b1, { settle: 0 }), hist, RULES);
  chk('a losing follow returns -1', loss.follow5_roi === -1);
  const tie = R.gradeBet(b1, hist.map((x) => ({ t: x.t, p: 0.44 })), RULES);
  chk('a close equal to the follow price is not beating it', tie.beat_close5 === false);
}

/* ── conviction ──────────────────────────────────────────────────────── */
chk('conviction = stake / median stake (300 / 100 = 3)', R.conviction(300, 100) === 3);
chk('no median, no conviction', R.conviction(300, 0) === null && R.conviction(0, 100) === null);
chk('3x is the high-conviction line (rules)', RULES.conviction_high_x === 3);

/* ── style ───────────────────────────────────────────────────────────── */
function styleWorld(nMarkets, twoSidedEvery, tradesPer, sharesA, sharesB) {
  const ms = {}, ts = [];
  for (let i = 0; i < nMarkets; i++) {
    const c = '0x' + String(i + 10).padStart(64, '4');
    ms[c] = mkt(c);
    for (let k = 0; k < tradesPer; k++) {
      const two = i % twoSidedEvery === 0;
      const oi = two && k % 2 ? 1 : 0;
      ts.push(trade(W, c, c + ':' + oi, oi, 'BUY', oi ? sharesB : sharesA, 0.5, T0 - H));
    }
  }
  return R.styleOf(ts, ms, RULES);
}
{
  /* every market two-sided, 6 trades each, 3 x 100 vs 3 x 90 shares: net ratio 30/570 = 0.053 */
  const mm = styleWorld(10, 1, 6, 100, 90);
  chk('market maker: all markets two-sided, 6 trades each, net ratio 0.05', mm.style === 'Market Maker' && mm.two_sided_share === 1 && mm.median_trades === 6, mm);
  const fewTrades = styleWorld(10, 1, 4, 100, 90);
  chk('…the same with 4 trades a market is a Hedger, not a market maker', fewTrades.style === 'Hedger', fewTrades);
  const lopsided = styleWorld(10, 1, 6, 100, 10);
  chk('…the same but lopsided (net ratio 0.82) is a Hedger', lopsided.style === 'Hedger' && lopsided.median_net_ratio > 0.3, lopsided);
  const hedger = styleWorld(10, 5, 2, 100, 100);
  chk('two of ten markets two-sided (20%) is a Hedger', hedger.style === 'Hedger' && hedger.two_sided_share === 0.2, hedger);
  const dir = styleWorld(10, 11, 2, 100, 100);
  chk('one of ten (10%) is Directional', dir.style === 'Directional' && dir.two_sided_share === 0.1, dir);
  const none = R.styleOf([], {}, RULES);
  chk('no covered market: Directional, zero markets', none.style === 'Directional' && none.markets === 0);
}

/* ── one wallet's grade ──────────────────────────────────────────────── */
function bets(n, o) {
  o = o || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const win = i % 2 === 0;
    out.push({ wallet: o.wallet || W, token_id: 't' + i, condition_id: 'c' + i, event_ref: 'g' + Math.floor(i / (o.perGame || 1)), entry_at: T0 - (n - i) * H, settle: win ? 1 : 0,
      result: win ? 'win' : 'loss', stake: o.stake ? o.stake(i) : 100, buy_cost: 100, profit: win ? (o.winProfit != null ? o.winProfit : 110) : -100,
      clv_pp: o.clv != null ? o.clv * 100 : 2, clv_pct: o.clv != null ? o.clv : 0.04, follow5_roi: win ? (o.fWin != null ? o.fWin : 1.1) : -1, follow15_roi: win ? 1.05 : -1,
      follow5_price: 0.48, close_price: o.close != null ? o.close : 0.5, beat_close5: (o.close != null ? o.close : 0.5) > 0.48, buy_cost_note: null });
  }
  return out;
}
{
  const small = R.gradeWallet(bets(49), { style: 'Directional' }, RULES);
  chk('49 graded bets: a small sample, no rank, no score', small.sample === 'small_sample' && small.radar_score === null);
  const g = R.gradeWallet(bets(50), { style: 'Directional' }, RULES);
  chk('50 graded bets: ranked', g.sample === 'ranked' && g.graded_bets === 50);
  chk('record 25-25-0', g.wins === 25 && g.losses === 25 && g.pushes === 0);
  /* profit 25 x 110 - 25 x 100 = 250 on 5,000 staked: ROI 0.05 */
  chk('ROI = 250 / 5,000 = 0.05', near(g.roi, 0.05) && near(g.profit, 250) && near(g.staked, 5000));
  /* follow ROI mean = (25 x 1.1 - 25) / 50 = 0.05 */
  chk('follow ROI (5) = 0.05 over 50', near(g.follow5_roi, 0.05) && g.follow5_n === 50);
  chk('CLV 2.0 pp, CLV% 0.04', near(g.clv_pp, 2) && near(g.clv_pct, 0.04));
  chk('beat-close rate 1.0 (0.50 > 0.48 every time)', g.beat_close5_rate === 1);
  /* score: each component shrunk by 50 / (50 + 50) = 0.5:
     100 x (0.5 x 0.025 + 0.3 x 0.02 + 0.2 x 0.025) = 100 x 0.0235 = 2.35 */
  chk('Radar Score = 100 x (0.5 x 0.025 + 0.3 x 0.02 + 0.2 x 0.025) = 2.35', near(g.radar_score, 2.35, 1e-9), g);
  chk('the score carries its shrunk components', near(g.score_parts.follow_roi, 0.025) && near(g.score_parts.clv_pct, 0.02) && near(g.score_parts.roi, 0.025));
  const many = R.gradeWallet(bets(400), { style: 'Directional' }, RULES);
  chk('only the 150 most recent graded bets count', many.graded_bets === 150 && many.last_bet_at === T0 - H);
  const med = R.gradeWallet(bets(51, { stake: (i) => (i < 26 ? 50 : 500) }), { style: 'Directional' }, RULES);
  chk('median stake (26 x 50, 25 x 500): 50', med.median_stake === 50);
}
{
  const mk = (w, score, n, style, trunc) => Object.assign(R.gradeWallet(bets(n, { wallet: w, fWin: score }), { style: style || 'Directional' }, RULES), { wallet: w, history_truncated: !!trunc });
  const gs = [];
  for (let i = 0; i < 30; i++) gs.push(mk('0x' + String(i).padStart(40, '0'), 1 + i / 100, 60));
  gs.push(mk('0x' + 'f'.repeat(40), 9, 60, 'Market Maker'));
  gs.push(mk('0x' + 'e'.repeat(40), 8, 60, 'Directional', true));
  gs.push(mk('0x' + 'd'.repeat(40), 9, 10));
  const ranked = R.rankWallets(gs, RULES);
  chk('every ranked wallet gets a rank, best score first', ranked.length === 32 && ranked[0].rank === 1 && ranked[0].wallet === '0x' + 'f'.repeat(40));
  chk('a market maker is ranked but never top-graded', ranked[0].top_directional === false);
  chk('a truncated history is never top-graded', ranked.find((g) => g.wallet === '0x' + 'e'.repeat(40)).top_directional === false);
  chk('exactly 25 top-graded directional wallets', ranked.filter((g) => g.top_directional).length === 25);
  chk('a small sample has no rank', gs.find((g) => g.wallet === '0x' + 'd'.repeat(40)).rank === null);
}

/* ── the bootstrap ───────────────────────────────────────────────────── */
{
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ cluster: 'g' + (i % 60), value: i % 3 === 0 ? 1 : 0 });
  const o = { B: RULES.bootstrap_resamples, seed: RULES.bootstrap_seed, level: RULES.ci_level };
  const a = R.clusterBootstrap(rows, o), b = R.clusterBootstrap(rows.slice().reverse(), o);
  chk('the mean is the plain mean (100 / 300)', near(a.mean, 1 / 3, 1e-6) && a.n === 300 && a.clusters === 60);
  chk('deterministic for the seed, whatever the row order', a.lo === b.lo && a.hi === b.hi);
  chk('the interval holds the mean', a.lo < a.mean && a.mean < a.hi);
  chk('one cluster of identical values: a zero-width interval', (() => { const c = R.clusterBootstrap([{ cluster: 'x', value: 2 }, { cluster: 'x', value: 2 }], o); return c.lo === 2 && c.hi === 2; })());
  chk('the bootstrap refuses to guess its settings', (() => { try { R.clusterBootstrap(rows, {}); return false; } catch (e) { return true; } })());
}

/* ── the H-RADAR-01 verdict ──────────────────────────────────────────── */
function followed(n, games, beatEvery, winEvery, price) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const win = i % winEvery === 0, beat = i % beatEvery !== 0;
    out.push({ condition_id: 'c' + i, event_ref: 'g' + (i % games), settle: win ? 1 : 0, result: win ? 'win' : 'loss', follow5_price: price, close_price: beat ? price + 0.03 : price - 0.03,
      follow5_roi: (win ? 1 : 0) / price - 1, follow15_price: price, follow15_roi: (win ? 1 : 0) / price - 1, buy_cost: 100, profit: win ? 100 : -100, clv_pct: 0.02 });
  }
  return out;
}
{
  /* 400 followed bets over 200 games at 0.40; 3 of 4 beat the close; half win: ROI = 0.5 / 0.4 - 1 = +0.25 */
  const good = R.evaluateHoldout(followed(400, 200, 4, 2, 0.40), RULES);
  chk('a strong holdout passes all three', good.passed && good.criteria.every((c) => c.met), good.criteria);
  chk('beat-close 0.75, follow ROI +0.25', near(good.beat_close.rate, 0.75, 1e-6) && near(good.follow_roi.mean, 0.25, 1e-6));
  const small = R.evaluateHoldout(followed(150, 75, 4, 2, 0.40), RULES);
  chk('150 followed bets: C1 fails alone, so it fails', !small.passed && !small.criteria[0].met && small.criteria[1].met && small.criteria[2].met);
  /* half beat the close: C2 fails, ROI still +0.25 */
  const coin = R.evaluateHoldout(followed(400, 200, 2, 2, 0.40), RULES);
  chk('half beating the close: C2 fails, so it fails', !coin.passed && !coin.criteria[1].met && coin.criteria[2].met);
  /* a quarter win at 0.40: ROI = 0.25 / 0.4 - 1 = -0.375 */
  const losing = R.evaluateHoldout(followed(400, 200, 4, 4, 0.40), RULES);
  chk('beating the close but losing money: C3 fails, so it fails', !losing.passed && losing.criteria[1].met && !losing.criteria[2].met && near(losing.follow_roi.mean, -0.375, 1e-6));
  const mixed = R.evaluateHoldout(followed(400, 200, 4, 2, 0.40).concat([
    { settle: null, result: 'open' }, { settle: null, result: 'void' }, { settle: 1, follow5_price: null, follow5_reason: 'started_before_follow' }, { settle: 1, follow5_price: 0.5, close_price: null }]), RULES);
  chk('exclusions are counted by reason and never followed', mixed.followed === 400 && mixed.bets === 404 && mixed.excluded.unresolved === 1 && mixed.excluded.void === 1
    && mixed.excluded.started_before_follow === 1 && mixed.excluded.no_close === 1, mixed.excluded);
  chk('the +1 cent sensitivity is lower than the primary ROI', mixed.secondary.plus_one_cent.follow_roi < mixed.follow_roi.mean);
  const empty = R.evaluateHoldout([], RULES);
  chk('no data: every criterion unmet, never a pass', !empty.passed && empty.criteria.every((c) => !c.met) && empty.beat_close.rate === null);
}

/* ── matching a market to one EdgeDesk game ──────────────────────────── */
const ev = (id, home, away, startMs, sport, sigs) => ({ event_id: id, sport_key: sport || 'americanfootball_nfl', home, away, commence_ms: startMs, sigs: sigs || [] });
const sigs = (home, away) => [
  { sig_key: 'h:' + home, market: 'h2h', selection: home, point: null }, { sig_key: 'h:' + away, market: 'h2h', selection: away, point: null },
  { sig_key: 's:' + home, market: 'spreads', selection: home, point: 3.5 }, { sig_key: 's:' + away, market: 'spreads', selection: away, point: -3.5 },
  { sig_key: 'o', market: 'totals', selection: 'Over', point: 47.5 }, { sig_key: 'u', market: 'totals', selection: 'Under', point: 47.5 }];
const E = [ev('E1', 'Las Vegas Raiders', 'Kansas City Chiefs', T0, null, sigs('Las Vegas Raiders', 'Kansas City Chiefs')), ev('E2', 'Buffalo Bills', 'Miami Dolphins', T0 + 3 * H),
  ev('E3', 'Texas Longhorns', 'Texas State Bobcats', T0, 'americanfootball_ncaaf'), ev('E4', 'Texas Tech Red Raiders', 'Baylor Bears', T0, 'americanfootball_ncaaf')];
{
  const m = mkt(C1, { closed: false, settle: null });
  const r = R.matchMarket(m, E, RULES);
  chk('moneyline: Chiefs / Raiders to E1, each outcome to its own team and h2h fair', r.event_id === 'E1' && r.sides[0].selection === 'Kansas City Chiefs' && r.sides[0].sig_key === 'h:Kansas City Chiefs'
    && r.sides[1].sig_key === 'h:Las Vegas Raiders' && r.confidence === 'high', r);
  const far = R.matchMarket(mkt(C1, { game_start_at: T0 - 7 * H }), E, RULES);
  chk('a start 7 hours away is no event (tolerance 6 hours)', far.reason === 'no_event', far);
  const two = R.matchMarket(mkt(C1), E.concat([ev('E1b', 'Las Vegas Raiders', 'Kansas City Chiefs', T0 + H)]), RULES);
  chk('two candidate games: ambiguous, not the nearest', two.reason === 'ambiguous_event', two);
  const unknown = R.matchMarket(mkt(C1, { outcomes: ['Jets', 'Raiders'] }), E, RULES);
  chk('a team that does not resolve: unmapped with its reason', unknown.reason === 'team_unresolved', unknown);
  const tx2 = R.matchMarket(mkt(C1, { league: 'cfb', outcomes: ['Texas State', 'Texas'] }), E, RULES);
  chk('"Texas" and "Texas State" each find their own team (Texas Tech is not Texas)', tx2.event_id === 'E3' && tx2.sides[0].selection === 'Texas State Bobcats' && tx2.sides[1].selection === 'Texas Longhorns', tx2);
  const tt = R.matchMarket(mkt(C1, { league: 'cfb', outcomes: ['Texas Tech', 'Baylor'] }), E, RULES);
  chk('"Texas Tech" vs "Baylor" goes to E4', tt.event_id === 'E4', tt);
  const sp = R.matchMarket(mkt(C1, { market_type: 'spreads', question: 'Spread: Raiders (+3.5)', outcomes: ['Chiefs', 'Raiders'], line: -3.5 }), E, RULES);
  chk('spreads: the question names the Raiders at +3.5; the Chiefs side is -3.5', sp.event_id === 'E1' && sp.sides[1].point === 3.5 && sp.sides[0].point === -3.5
    && sp.sides[1].sig_key === 's:Las Vegas Raiders' && sp.sides[0].sig_key === 's:Kansas City Chiefs', sp);
  const spLine = R.matchMarket(mkt(C1, { market_type: 'spreads', question: 'Chiefs vs. Raiders spread', outcomes: ['Raiders', 'Chiefs'], line: 3.5 }), E, RULES);
  chk('spreads with no number in the question: the line is the first outcome\'s', spLine.sides[0].point === 3.5 && spLine.sides[0].sig_key === 's:Las Vegas Raiders', spLine);
  const off = R.matchMarket(mkt(C1, { market_type: 'spreads', question: 'Spread: Raiders (+4.5)', outcomes: ['Chiefs', 'Raiders'] }), E, RULES);
  chk('a spread at a line the board does not price: mapped, but no fair (never another line\'s)', off.event_id === 'E1' && off.sides.every((s) => s.sig_key === null), off);
  const tot = R.matchMarket(mkt(C1, { market_type: 'totals', outcomes: ['Over', 'Under'], line: 47.5, question: 'Chiefs vs. Raiders: O/U 47.5', event_title: 'Chiefs vs. Raiders' }), E, RULES);
  chk('totals: the event title names the teams; Over / Under at 47.5', tot.event_id === 'E1' && tot.sides[0].sig_key === 'o' && tot.sides[1].sig_key === 'u', tot);
  chk('a league Radar does not cover is unmapped', R.matchMarket(mkt(C1, { league: 'epl' }), E, RULES).reason === 'league_not_covered');
  chk('a futures-style Yes / No market is not a game market', R.matchMarket(mkt(C1, { market_type: null }), E, RULES).reason === 'market_type_not_covered');
}
/* names */
chk('a nickname reads ("Chiefs" in "Kansas City Chiefs")', R.teamScore('Chiefs', 'Kansas City Chiefs') === 2);
chk('a school reads ("Alabama" in "Alabama Crimson Tide")', R.teamScore('Alabama', 'Alabama Crimson Tide') === 1);
chk('"Texas" is not "Texas Tech Red Raiders"', R.teamScore('Texas', 'Texas Tech Red Raiders') === 0);
chk('"St." at the end is State ("Michigan St." is Michigan State)', R.teamScore('Michigan St.', 'Michigan State Spartans') === 1);
chk('"St. Louis Blues" keeps its saint', R.teamScore('Blues', 'St. Louis Blues') === 2);
chk('accents fold ("Montréal" is "Montreal")', R.teamScore('Montréal Canadiens', 'Montreal Canadiens') === 3);

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail ? 'FAILED' : 'ALL GREEN') + ' radar core — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
