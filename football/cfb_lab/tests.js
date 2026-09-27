/* ============================================================================
   CFB Model Lab — tests (node football/cfb_lab/tests.js).

   The brief's list (§40): immutable predictions, duplicate snapshots,
   incorrect timestamps, post-kickoff predictions, spread sign, CLV sign, ATS
   grading, pushes, canceled games, overtime, missing market close, stale odds,
   market consensus, calibration buckets, prediction intervals, model version
   attribution — plus the checkpoint windows, the OFFICIAL rule, quote
   de-duplication, openers and closes (checked against the same fixture the
   Postgres functions are tested with), settlement agreement and corrections,
   miss classification, near misses, data quality, governance and the public
   record. Everything runs in temporary directories; nothing touches the real
   ledger.
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const MK = require('./market.js');
const CP = require('./checkpoint.js');
const ST = require('./settle.js');
const RP = require('./report.js');
const GOV = require('./governance.js');
const M = require('./models.js');

const U = L.util;
let pass = 0, fail = 0;
const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }
function throws(f) { try { f(); return false; } catch (e) { return true; } }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cfblab-')); }
function storeIn(dir) { return new G.Store(2026, { root: path.join(dir, 'ledger'), govRoot: path.join(dir, 'gov') }); }
const K = '2026-10-03T19:30:00.000Z';

/* a model projection shaped like models.js adapters return */
function proj(o) {
  o = o || {};
  const margin = o.margin == null ? 3.5 : o.margin, sigma = o.sigma == null ? 15 : o.sigma;
  return {
    model_version: o.mv || 'test_model_v1', model_label: o.label || 'T', engine_id: 'test', source: 'test',
    projection_computed_at: '2026-09-29T12:00:00.000Z', feature_ts: '2026-09-29T12:00:00.000Z', feature_version: 'fv', calibration_version: 'cv', ensemble_version: 'ev', params_hash: 'ph',
    game: { game_id: o.game_id || 'g1', season: 2026, week: o.week || 6, season_type: 'regular', home: 'Home U', away: 'Away St', home_id: 'h', away_id: 'a', neutral_site: false, kickoff: o.kickoff || K },
    pure: { margin, total: 50, p_home: o.p_home == null ? 0.6 : o.p_home, sigma, t_df: 100,
      intervals: o.intervals === null ? null : { 50: [margin - 10, margin + 10], 80: [margin - 19, margin + 19], 95: [margin - 29, margin + 29] },
      home_pts: (50 + margin) / 2, away_pts: (50 - margin) / 2, confidence_raw: o.conf == null ? 80 : o.conf, ens_sd: o.ens_sd == null ? 1.2 : o.ens_sd },
    components: o.components || { C_ridge: margin - 0.5, D_gbm: margin + 0.5 },
    state: { data_completeness: 0.9, pbp_completeness: 1 },
    explain: { primary_edge: 'edge_epa +2', secondary_edge: null, primary_uncertainty: null, disagreement_summary: null },
    slateGame: o.slateGame || null, inputs: {},
    decide: o.decide || ((market) => {
      const gap = market && U.isNum(market.current_spread) ? margin - L.conv.bookToMargin(market.current_spread) : null;
      const d = L.v1Decision(gap);
      return { status: d.status, side: d.side, decision_source: 'test', reason: d.reason, cover_probability: o.cover == null ? 0.53 : o.cover, break_even_probability: 0.5238,
        estimated_ev: 0.01, edge_quality: o.edge == null ? 30 : o.edge, betting_reliability: 80, threshold_distance: null, bet_enabled: !!o.bet_enabled };
    }),
  };
}
const GREEN = { status: 'GREEN', checks: [{ check: 'x', status: 'GREEN' }] };
function row(o, ct, now, market, origin) {
  const p = proj(o);
  return CP.buildRow(p, ct || 'T24', !!(o && o.first), market || null, p.decide(market || null), (o && o.dq) || GREEN, { now: now || '2026-10-02T21:00:00.000Z', role: (o && o.role) || 'champion', origin: origin || 'LIVE' });
}
function q(o) {
  return MK.baseQuote(Object.assign({ game_id: 'g1', season: 2026, week: 6, source: 'odds_api', book: 'dk', market_type: 'spread', home_line: -3, price_home: -110, price_away: -110,
    observed_at: '2026-10-01T12:00:00.000Z', kickoff_ts: K, retrieved_at: '2026-10-01T12:00:00.000Z' }, o));
}

/* ═══ 1. signs ═════════════════════════════════════════════════════════ */
{
  chk('book home line -7 is home margin +7', L.conv.bookToMargin(-7) === 7);
  chk('margin -3 is book home line +3', L.conv.marginToBook(-3) === 3);
  chk('pick is 0 both ways (no -0)', Object.is(L.conv.bookToMargin(0), 0) && Object.is(L.conv.marginToBook(0), 0));
  chk('away side line is the negated home line', L.conv.sideLine('AWAY', -3.5) === 3.5 && L.conv.sideLine('HOME', -3.5) === -3.5);
  chk('display names the favourite', L.conv.display(3.2, 'Home U', 'Away St') === 'Home U -3.0' && L.conv.display(-7.26, 'Home U', 'Away St') === 'Away St -7.5');
  const r = row({ margin: 4 });
  chk('snapshot fair line = -pure margin', r.fair_spread_home_line === -4 && r.pure_home_margin === 4);
  const r2 = row({ margin: 4 }, 'T24', null, L.marketAt([q({ home_line: -2.5, observed_at: '2026-10-02T20:00:00.000Z' })], '2026-10-02T21:00:00.000Z', K));
  chk('gap positive = the model likes home more than the market', r2.model_market_gap === 1.5, r2.model_market_gap);
  chk('V1 lean rule side follows the gap sign', L.v1Decision(2.5).side === 'HOME' && L.v1Decision(-2.5).side === 'AWAY' && L.v1Decision(1.9).status === 'PASS');
}

/* ═══ 2. checkpoints and the OFFICIAL rule ═════════════════════════════ */
{
  const w = (h) => L.windowFor(h);
  chk('windows: 80h OPEN, 72h T72, 48h T48, 24h T24, 12.01h T24, 12h T12, 2h T2, 1h FINAL, 0.2h FINAL',
    w(80) === 'OPEN' && w(72) === 'T72' && w(48) === 'T48' && w(24) === 'T24' && w(12.01) === 'T24' && w(12) === 'T12' && w(2) === 'T2' && w(1) === 'FINAL' && w(0.2) === 'FINAL');
  chk('no window at or after kickoff', w(0) === null && w(-1) === null);
  chk('OPEN only for a first snapshot', L.dueCheckpoint(90, []) === 'OPEN' && L.dueCheckpoint(90, ['OPEN']) === null);
  chk('a window is taken once', L.dueCheckpoint(30, ['OPEN']) === 'T48' && L.dueCheckpoint(30, ['OPEN', 'T48']) === null);
  chk('a missed window is never back-filled (at 10h only T12 is due, never T24)', L.dueCheckpoint(10, ['T48']) === 'T12');
  chk('OFFICIAL family only on LIVE T24', L.familiesFor('T24', false, 'LIVE').includes('OFFICIAL') && !L.familiesFor('T24', false, 'REPLAY').includes('OFFICIAL') && !L.familiesFor('T12', false, 'LIVE').includes('OFFICIAL'));
  chk('EARLY / MIDWEEK / FINAL families', L.familiesFor('OPEN', true, 'LIVE').includes('EARLY_MODEL') && L.familiesFor('T48', false, 'LIVE').includes('MIDWEEK_MODEL') && L.familiesFor('FINAL', false, 'LIVE').includes('FINAL_MODEL'));
  chk('isOfficial', L.isOfficial({ origin: 'LIVE', checkpoint_type: 'T24' }) && !L.isOfficial({ origin: 'GIT_RECONSTRUCTED', checkpoint_type: 'T24' }));
}

/* ═══ 3. the ledger: immutability, duplicates, timestamps ═══════════════ */
{
  const d = tmp(), s = storeIn(d);
  const a = row({ game_id: 'g1' }, 'T24', '2026-10-02T21:00:00.000Z');
  chk('row hash and id are content-derived', a.row_hash === G.rowHash(a) && a.prediction_id === G.ids.prediction(a) && /^cfbp_[0-9a-f]{24}$/.test(a.prediction_id));
  chk('first write', s.appendPredictions([a]).written === 1);
  chk('the same row again is a no-op', s.appendPredictions([a]).written === 0 && s.predictions().length === 1);
  const b = row({ game_id: 'g1', margin: 9 }, 'T24', '2026-10-02T22:00:00.000Z');
  const rb = s.appendPredictions([b]);
  chk('a second LIVE T24 for the same game and model is refused', rb.written === 0 && rb.refused_duplicate_checkpoint.length === 1);
  const rc = row({ game_id: 'g1', margin: 9 }, 'T24', '2026-10-02T22:00:00.000Z', null, 'GIT_RECONSTRUCTED');
  chk('a reconstructed T24 does not occupy the LIVE slot (and vice versa)', s.appendPredictions([rc]).written === 1);
  const ad1 = row({ game_id: 'g1' }, 'ADHOC', '2026-10-02T23:00:00.000Z'), ad2 = row({ game_id: 'g1', margin: 1 }, 'ADHOC', '2026-10-02T23:30:00.000Z');
  chk('ADHOC snapshots may repeat', s.appendPredictions([ad1, ad2]).written === 2);
  const edited = Object.assign({}, a, { pure_home_margin: 10 });
  chk('an edited row is refused (row_hash)', throws(() => s.appendPredictions([edited])));
  const late = row({ game_id: 'g2' }, 'FINAL', K);
  chk('a post-kickoff snapshot is refused', throws(() => s.appendPredictions([late])));
  const wrongH = Object.assign({}, row({ game_id: 'g3' }, 'T24')); wrongH.hours_to_kickoff = 30; wrongH.prediction_id = G.ids.prediction(wrongH); wrongH.row_hash = G.rowHash(wrongH);
  chk('inconsistent hours_to_kickoff is refused', throws(() => s.appendPredictions([wrongH])));
  const wrongSign = Object.assign({}, row({ game_id: 'g4' }, 'T24')); wrongSign.fair_spread_home_line = wrongSign.pure_home_margin; wrongSign.row_hash = G.rowHash(wrongSign);
  chk('a sign-flipped fair line is refused', throws(() => s.appendPredictions([wrongSign])));
  const fakeOff = Object.assign({}, row({ game_id: 'g5' }, 'T12')); fakeOff.official_families = ['OFFICIAL']; fakeOff.row_hash = G.rowHash(fakeOff);
  chk('OFFICIAL on a T12 is refused', throws(() => s.appendPredictions([fakeOff])));
  const stake = Object.assign({}, row({ game_id: 'g6' }, 'T24')); stake.stake_units = 1; stake.bet_enabled = false; stake.row_hash = G.rowHash(stake);
  chk('a stake without BET enabled is refused', throws(() => s.appendPredictions([stake])));
  chk('ledger verify passes on an intact ledger', G.verify({ roots: [path.join(d, 'ledger')], repo: d }).length === 0);
  const f = s.f.predictions(6);
  const txt = fs.readFileSync(f, 'utf8').split('\n');
  const obj = JSON.parse(txt[0]); obj.pure_home_margin = 99; txt[0] = JSON.stringify(obj);
  fs.writeFileSync(f, txt.join('\n'));
  chk('verify catches an edited committed row', G.verify({ roots: [path.join(d, 'ledger')], repo: d }).some((p) => /row_hash/.test(p)));
  /* append-only against a git base */
  const g = tmp();
  execFileSync('git', ['init', '-q', g]); execFileSync('git', ['-C', g, 'config', 'user.email', 't@t']); execFileSync('git', ['-C', g, 'config', 'user.name', 't']);
  const gs = new G.Store(2026, { root: path.join(g, 'ledger'), govRoot: path.join(g, 'gov') });
  gs.appendPredictions([row({ game_id: 'g1' }, 'T24'), row({ game_id: 'g2' }, 'T24')]);
  execFileSync('git', ['-C', g, 'add', '-A']); execFileSync('git', ['-C', g, 'commit', '-qm', 'base']);
  gs.appendPredictions([row({ game_id: 'g3' }, 'T24')]);
  chk('appending after the base is fine', G.verify({ roots: [path.join(g, 'ledger')], repo: g, base: 'HEAD' }).length === 0);
  const pf = gs.f.predictions(6), lines = fs.readFileSync(pf, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(pf, lines.slice(1).join('\n') + '\n');
  chk('removing a committed line is caught against the base', G.verify({ roots: [path.join(g, 'ledger')], repo: g, base: 'HEAD' }).some((p) => /append-only/.test(p)));
}

/* ═══ 4. quotes: de-duplication, consensus, openers, closes ═════════════ */
{
  const base = q({ observed_at: '2026-10-01T12:00:00.000Z' });
  chk('first quote is written', L.dedupeDecision(null, base) === 'written');
  chk('unchanged within 6 h is a duplicate', L.dedupeDecision(base, q({ observed_at: '2026-10-01T15:00:00.000Z' })) === 'duplicate');
  chk('unchanged after 6 h is a heartbeat', L.dedupeDecision(base, q({ observed_at: '2026-10-01T18:00:00.000Z' })) === 'written');
  chk('a changed line is written', L.dedupeDecision(base, q({ home_line: -3.5, observed_at: '2026-10-01T12:05:00.000Z' })) === 'written');
  chk('a changed price is written', L.dedupeDecision(base, q({ price_home: -115, observed_at: '2026-10-01T12:05:00.000Z' })) === 'written');
  const lastHr = q({ observed_at: '2026-10-03T17:00:00.000Z' });
  chk('close zone: unchanged 50+ min later is a heartbeat', L.dedupeDecision(lastHr, q({ observed_at: '2026-10-03T17:55:00.000Z' })) === 'written');
  chk('close zone: unchanged 30 min later is a duplicate', L.dedupeDecision(lastHr, q({ observed_at: '2026-10-03T17:30:00.000Z' })) === 'duplicate');
  chk('a quote at kickoff is refused (never in-play)', L.dedupeDecision(null, q({ observed_at: K })) === 'refused');
  const sel = MK.selectNew([], [q({ observed_at: '2026-10-01T12:00:00.000Z' }), q({ observed_at: '2026-10-01T13:00:00.000Z' }), q({ home_line: -4, observed_at: '2026-10-01T14:00:00.000Z' }), q({ home_line: -4, observed_at: '2026-10-01T21:00:00.000Z' })]);
  chk('selectNew: change + heartbeat kept, duplicate dropped', sel.stats.written === 3 && sel.stats.duplicates === 1 && sel.rows[2].is_heartbeat === true, sel.stats);
  chk('price median in decimal space (straddling +/-100)', L.medianPrice([-105, 105]) === 100 && L.medianPrice([-110, -105]) === -107 && L.medianPrice([-110, -110, 100]) === -110);
  chk('round half away from zero', L.roundHalfAway(-107.5) === -108 && L.roundHalfAway(107.5) === 108);
  const Q = [q({ book: 'dk', observed_at: '2026-09-28T12:00:00.000Z', home_line: -3 }), q({ book: 'fd', observed_at: '2026-09-28T20:00:00.000Z', home_line: -3.5 }),
    q({ book: 'mgm', observed_at: '2026-09-30T12:00:00.000Z', home_line: -2.5 }), q({ book: 'dk', observed_at: '2026-10-03T17:00:00.000Z', home_line: -4 }),
    q({ book: 'fd', observed_at: '2026-10-03T18:45:00.000Z', home_line: -4.5 }), q({ book: 'mgm', observed_at: '2026-10-03T15:00:00.000Z', home_line: -3 }),
    q({ source: 'cfbd', book: 'consensus', observed_at: '2026-09-27T12:00:00.000Z', home_line: -2, price_home: null, price_away: null })];
  const op = L.openerFrom(Q, 'spread').consensus;
  chk('opener: books within 24 h of the first, provider average dropped, time of the first real book', op.home_line === -3 && op.n_books === 1 && op.observed_at === '2026-09-28T12:00:00.000Z' && op.quality === 'OBSERVED', op);
  const cl = L.closeFrom(Q, 'spread', K).consensus;
  chk('close: last quotes inside [kickoff-180m, kickoff), median, best numbers per side', cl.home_line === -4.25 && cl.n_books === 2 && cl.best_line_home === -4 && cl.best_line_away === 4.5, cl);
  const onlyDecl = [q({ is_provider_close: true, is_pregame: false, observed_at: '2026-10-04T01:00:00.000Z', home_line: -6 })];
  chk('close fallback: provider-declared', L.closeFrom(onlyDecl, 'spread', K).consensus.quality === 'PROVIDER_DECLARED' && L.closeFrom(onlyDecl, 'spread', K).consensus.home_line === -6);
  chk('missing close is MISSING, never invented', L.closeFrom([], 'spread', K).consensus.quality === 'MISSING' && L.closeFrom([], 'spread', K).consensus.home_line === null);
  chk('a quote exactly at kickoff-180m is inside the window', L.closeFrom([q({ observed_at: '2026-10-03T16:30:00.000Z', home_line: -5 })], 'spread', K).consensus.home_line === -5);
  chk('close is derived only 3 h after kickoff', !L.closeDue(K, '2026-10-03T22:29:00.000Z') && L.closeDue(K, '2026-10-03T22:30:00.000Z'));
  const mk = L.marketAt(Q, '2026-10-03T18:50:00.000Z', K);
  chk('market at a moment: latest per book, median, opener as known', mk.current_spread === -4 && mk.sportsbook_count === 3 && mk.opening_spread === -3, mk);
  chk('stale odds are flagged (newest quote > 6 h with <= 48 h to go)', L.marketAt([q({ observed_at: '2026-10-02T05:00:00.000Z' })], '2026-10-02T21:00:00.000Z', K).market_stale === true);
  chk('fresh odds are not stale', L.marketAt([q({ observed_at: '2026-10-02T20:00:00.000Z' })], '2026-10-02T21:00:00.000Z', K).market_stale === false);
  /* the shared fixture with the Postgres functions, when present */
  const fx = path.join(__dirname, 'fixtures', 'market_rules.json');
  if (fs.existsSync(fx)) {
    const F = JSON.parse(fs.readFileSync(fx, 'utf8'));
    (F.hash_cases || []).forEach((c, i) => chk('hash parity case ' + i, G.h(...c.parts) === c.expected, { got: G.h(...c.parts), c }));
    (F.dedupe_cases || []).forEach((c, i) => {
      const stored = [];
      (c.observations || []).forEach((o, j) => {
        const cand = MK.baseQuote(Object.assign({ kickoff_ts: c.kickoff_ts, is_pregame: true, is_provider_open: false, is_provider_close: false }, o));
        const r = MK.selectNew(stored, [cand], { eventMap: c.event_map || [] });
        const got = r.stats.written ? 'written' : (r.stats.refused ? 'refused' : 'duplicate');
        stored.push(...r.rows);
        const w = r.rows[0];
        const extra = got !== 'written' || ((o.heartbeat === undefined || w.is_heartbeat === o.heartbeat) && (o.expect_game_id === undefined || w.game_id === o.expect_game_id));
        chk('dedupe parity case ' + i + '.' + j + ' (' + (c.why || '') + ')', got === o.expect && extra, { got, expect: o.expect, row: w && { hb: w.is_heartbeat, gid: w.game_id } });
      });
    });
    (F.line_cases || []).forEach((c, i) => {
      const quotes = (c.quotes || []).map((o) => MK.baseQuote(Object.assign({ game_id: c.game_id, kickoff_ts: c.kickoff_ts, is_pregame: true, is_provider_open: false, is_provider_close: false }, o)));
      const games = c.register_with_prediction ? [{ game_id: c.game_id, kickoff_ts: c.kickoff_ts }] : [];
      const got = MK.deriveLines(quotes, [], new Date(U.ms(c.kickoff_ts) + 4 * 3600000).toISOString(), games);
      const same = (e, l) => l.kind === e.kind && l.market_type === e.market_type && l.book === e.book;
      (c.expected || []).forEach((e, j) => {
        const m = got.find((l) => same(e, l));
        const ok = m && Object.keys(e).every((k) => e[k] === m[k] || (e[k] === null && m[k] == null));
        chk('line parity case ' + i + '.' + j + ' ' + e.kind + ' ' + e.book + ' ' + e.market_type, !!ok, { expected: e, got: m });
      });
      chk('line parity case ' + i + ': no extra lines (the expected set is complete)', got.every((l) => (c.expected || []).some((e) => same(e, l))), got.filter((l) => !(c.expected || []).some((e) => same(e, l))).map((l) => l.kind + ' ' + l.book + ' ' + l.market_type));
    });
  } else chk('shared market fixture present (fixtures/market_rules.json)', false, 'missing');
}

/* ═══ 4b. Odds API events -> games (the board's own join) ═══════════════ */
{
  const games = [
    { game_id: 'g_tx', home_team: 'Texas', away_team: 'Oklahoma', home_id: 'texas', away_id: 'oklahoma', kickoff: '2026-10-10T19:30:00.000Z' },
    { game_id: 'g_mia', home_team: 'Miami', away_team: 'Florida State', home_id: 'miami', away_id: 'floridastate', kickoff: '2026-10-10T23:30:00.000Z' },
  ];
  const oa = (pe, home, away, kick, extra) => MK.baseQuote(Object.assign({ game_id: null, source: 'odds_api', provider_event_id: pe, book: 'draftkings', market_type: 'spread', home_line: -6.5,
    price_home: -110, price_away: -110, observed_at: '2026-10-08T12:00:00.000Z', kickoff_ts: kick, home_team: home, away_team: away }, extra));
  const quotes = [
    oa('e_tx', 'Texas Longhorns', 'Oklahoma Sooners', '2026-10-10T19:30:00Z'),
    oa('e_swap', 'Oklahoma Sooners', 'Texas Longhorns', '2026-10-10T19:30:00Z'),
    oa('e_miaoh', 'Miami (OH) RedHawks', 'Florida State Seminoles', '2026-10-10T23:30:00Z'),
    oa('e_far', 'Miami Hurricanes', 'Florida State Seminoles', '2026-10-20T23:30:00Z'),
  ];
  const mp = MK.mapOddsEvents(quotes, [], games, '2026-10-08T12:05:00.000Z');
  chk('Odds API: a book fixture joins to its game (school + nickname -> the schedule\'s school)', mp.rows.length === 1 && mp.rows[0].provider_event_id === 'e_tx' && mp.rows[0].game_id === 'g_tx'
    && mp.rows[0].method === 'teams_and_kickoff' && /^cfbx_[0-9a-f]{24}$/.test(mp.rows[0].map_id), mp);
  chk('Odds API: a swapped home/away is refused, never mapped (the home line would be the wrong sign)', !mp.rows.some((r) => r.provider_event_id === 'e_swap'));
  chk('Odds API: Miami (OH) never takes Miami (FL)\'s game', !mp.rows.some((r) => r.provider_event_id === 'e_miaoh'));
  chk('Odds API: a kickoff more than 36 h from the schedule is refused', !mp.rows.some((r) => r.provider_event_id === 'e_far'));
  chk('Odds API: refusals are counted with reasons', mp.refused === 3 && Object.keys(mp.refusal_reasons).length >= 2, mp.refusal_reasons);
  chk('Odds API: an event already in the map is not mapped again', MK.mapOddsEvents(quotes, mp.rows, games, '2026-10-08T13:05:00.000Z').rows.length === 0);
  /* end to end through capture(): unmapped quotes from Postgres -> map -> stored under the game */
  const d = tmp(), so = { root: path.join(d, 'ledger'), govRoot: path.join(d, 'gov') };
  const pulled = quotes.map((q) => Object.assign({}, q, { observed_at: q.observed_at.replace('.000Z', '+00:00'), recorded_at: 'x' }));
  MK.capture(2026, '2026-10-08T12:05:00.000Z', { espn: false, cfbd: false, supabaseQuotes: pulled.map((q) => { const o = Object.assign({}, q); delete o.recorded_at; o.observed_at = U.iso(o.observed_at); return o; }), games, storeOpts: so })
    .then((r) => {
      const st = new G.Store(2026, so);
      const tx = st.quotes().find((q) => q.provider_event_id === 'e_tx');
      chk('capture: the joined event is written to the event map', st.eventMap().length === 1 && r.log.supabase.mapped_now === 1, r.log);
      chk('capture: its quote is stored under the game, with the id the rule gives it', tx && tx.game_id === 'g_tx' && tx.quote_id === G.ids.quote(tx) && tx.season === 2026, tx);
      chk('capture: an unmapped event is stored under its provider event, never a guessed game', st.quotes().filter((q) => q.game_id === null).length === 3);
      chk('capture: the ledger is intact afterwards', G.verify({ roots: [so.root, so.govRoot] }).length === 0);
    }).catch((e) => chk('capture with supabase quotes ran', false, String(e)));
}

/* ═══ 5. grading: ATS, pushes, CLV, units, void, overtime ════════════════ */
{
  chk('ATS home -3 wins by 4 = WIN, by 3 = PUSH, by 2 = LOSS', L.atsResult('HOME', -3, 4) === 'WIN' && L.atsResult('HOME', -3, 3) === 'PUSH' && L.atsResult('HOME', -3, 2) === 'LOSS');
  chk('ATS away +3 loses by 2 = WIN, by 3 = PUSH', L.atsResult('AWAY', -3, 2) === 'WIN' && L.atsResult('AWAY', -3, 3) === 'PUSH');
  chk('ATS away as favourite (home +7), home wins = LOSS', L.atsResult('AWAY', 7, 1) === 'LOSS');
  chk('units: win at -110 = 0.909, push 0, loss -1', U.r(L.unitsFor('WIN', 1, -110), 3) === 0.909 && L.unitsFor('PUSH', 1, -110) === 0 && L.unitsFor('LOSS', 1, -110) === -1);
  chk('CLV (brief example): home -3, closes -5 = +2', L.clvPoints('HOME', -3, -5) === 2);
  chk('CLV: away +3 (home -3), closes home -5 = -2', L.clvPoints('AWAY', -3, -5) === -2);
  chk('CLV: home -3 closes -2 = -1', L.clvPoints('HOME', -3, -2) === -1);
  chk('price CLV only on equal lines', L.clvPrice('HOME', -3, -3, -110, -125) > 0 && L.clvPrice('HOME', -3, -3.5, -110, -125) === null);
  const P = row({ margin: 4 }, 'T24', '2026-10-02T21:00:00.000Z', L.marketAt([q({ home_line: -2, observed_at: '2026-10-02T20:00:00.000Z' })], '2026-10-02T21:00:00.000Z', K));
  const res = { result_id: 'r1', status: 'FINAL', home_points: 27, away_points: 24, overtime: false };
  const close = { quality: 'OBSERVED', home_line: -3, price_home: -110, price_away: -110, line_id: 'c1', n_books: 3 };
  const open = { quality: 'OBSERVED', home_line: -1.5 };
  const e = L.evaluate(P, res, { open, close });
  chk('margin error = actual - predicted', e.margin_error === -1 && e.abs_margin_error === 1 && e.squared_margin_error === 1);
  chk('winner correct', e.winner_correct === true);
  chk('model side HOME at -2, won by 3 = WIN; at the close -3 = PUSH', e.side === 'HOME' && e.ats_result === 'WIN' && e.ats_result_at_close === 'PUSH', e);
  chk('CLV of the graded number: -2 vs close -3 = +1, process GOOD', e.clv_points === 1 && e.positive_clv === true && e.process_quality === 'GOOD' && e.outcome_quadrant === 'GOOD_PROCESS_WIN');
  chk('edge vs open and move toward the model', e.edge_vs_open === 2.5 && e.market_move_points === 1.5 && e.market_move_toward_model === true);
  chk('beat the close on accuracy (1 vs 0)', e.edgedesk_beat_close === false && e.error_diff_vs_close === 1);
  chk('interval hit', e.in_interval_50 === true);
  chk('the captured price is the graded price', e.price_assumed === false && e.graded_price === -110);
  const NP = row({ margin: 4 }, 'T24', '2026-10-02T21:00:00.000Z', L.marketAt([q({ home_line: -2, price_home: null, price_away: null, observed_at: '2026-10-02T20:00:00.000Z' })], '2026-10-02T21:00:00.000Z', K));
  const enp = L.evaluate(NP, res, { open, close });
  chk('no price captured: -110 assumed and flagged', NP.recommended_price == null && enp.price_assumed === true && enp.graded_price === -110 && enp.hypothetical_units === 0.9091, enp);
  chk('Brier of a 0.6 home favourite that won = 0.16', e.brier_win === 0.16);
  const v = L.evaluate(P, { result_id: 'r2', status: 'CANCELED' }, {});
  chk('canceled game is VOID: no error, no result', v.void === true && v.ats_result === 'VOID' && v.margin_error === undefined);
  chk('VOID excluded from error summaries and betting', L.errorSummary([v]).n === 0 && L.betting([v]).decisions === 0);
  const nc = L.evaluate(P, res, { open });
  chk('missing close: quality MISSING, CLV null, no beat-close claim', nc.close_quality === 'MISSING' && nc.clv_points === null && nc.edgedesk_beat_close === null);
  const readings = ST.espnReadings([{ events: [
    { id: '1', competitions: [{ status: { period: 5, type: { completed: true, state: 'post', name: 'STATUS_FINAL' } }, competitors: [{ homeAway: 'home', score: '30' }, { homeAway: 'away', score: '27' }] }] },
    { id: '2', competitions: [{ status: { period: 4, type: { completed: true, state: 'post', name: 'STATUS_FINAL' } }, competitors: [{ homeAway: 'home', score: '10' }, { homeAway: 'away', score: '7' }] }] },
    { id: '3', competitions: [{ status: { period: 0, type: { completed: false, state: 'post', name: 'STATUS_POSTPONED' } }, competitors: [{ homeAway: 'home' }, { homeAway: 'away' }] }] }] }]);
  chk('overtime from ESPN period count', readings['1'].overtime === true && readings['2'].overtime === false);
  chk('postponed recognised', readings['3'].status === 'POSTPONED');
  const rr = ST.resultsFrom([readings, { '1': { source: 'cfbfastR', status: 'FINAL', home_points: 30, away_points: 27, overtime: null } }], [], '2026-10-04T12:00:00.000Z');
  const r1 = rr.rows.find((r) => r.game_id === '1');
  chk('FINAL when both sources agree, overtime kept', r1 && r1.status === 'FINAL' && r1.overtime === true && r1.final_margin === 3 && r1.sources_agree === true);
  const dis = ST.resultsFrom([readings, { '2': { source: 'cfbfastR', status: 'FINAL', home_points: 10, away_points: 14 } }], [], '2026-10-04T12:00:00.000Z');
  chk('disagreeing sources write nothing', !dis.rows.some((r) => r.game_id === '2') && dis.disagreements.some((x) => x.game_id === '2'));
  const corr = ST.resultsFrom([{ '1': { source: 'espn', status: 'FINAL', home_points: 31, away_points: 27 } }], rr.rows, '2026-10-05T12:00:00.000Z');
  chk('a corrected score supersedes, never edits', corr.rows.length === 1 && corr.rows[0].supersedes === r1.result_id);
  chk('an unchanged reading writes nothing', ST.resultsFrom([readings], rr.rows, '2026-10-05T12:00:00.000Z').rows.filter((r) => r.game_id === '1').length === 0);
}

/* ═══ 6. calibration, intervals, summaries ═════════════════════════════ */
{
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push({ p: 0.7, y: i < 70 ? 1 : 0 });
  for (let i = 0; i < 100; i++) pairs.push({ p: 0.3, y: i < 30 ? 1 : 0 });
  const c = L.calibration(pairs, true);
  const b = c.buckets.find((x) => x.bucket === '70-75');
  chk('folded to the favourite: 200 in 70-75, observed 0.70', b.n === 200 && b.observed === 0.7 && b.predicted === 0.7, b);
  chk('perfect calibration ECE 0', c.ece === 0);
  chk('calibration slope reported at n >= 200', U.isNum(c.slope));
  chk('small samples are labelled', L.calibration([{ p: 0.6, y: 1 }], true).label === 'small sample');
  const under = L.calibration(pairs.slice(0, 20), true);
  chk('no slope below 200', under.slope === null && /insufficient/.test(under.slope_note));
  const evs = [];
  for (let i = 0; i < 100; i++) evs.push({ in_interval_50: i < 50, in_interval_80: i < 61, in_interval_95: i < 95 });
  const iv = L.intervalReport(evs);
  chk('80% intervals covering 61% are OVERCONFIDENT', iv.p80.coverage === 0.61 && iv.p80.verdict === 'OVERCONFIDENT');
  chk('50% intervals covering 50% are within band', iv.p50.verdict === 'within band');
  const es = [3, -5, 10, -1].map((x, i) => ({ margin_error: x, abs_margin_error: Math.abs(x), squared_margin_error: x * x, final_margin: 10, brier_win: 0.1, in_interval_80: i % 2 === 0 }));
  const s = L.errorSummary(es);
  chk('MAE, RMSE, bias, median', s.mae === 4.75 && s.rmse === U.r(Math.sqrt(135 / 4), 3) && s.bias === 1.75 && s.median_ae === 4);
  chk('P90/P95 by linear interpolation', s.p90_ae === U.r(U.quantile([3, 5, 10, 1], 0.9), 3));
  const bt = L.betting([{ side: 'HOME', ats_result: 'WIN', hypothetical_units: 0.909, kickoff_ts: '2026-10-01' }, { side: 'HOME', ats_result: 'LOSS', hypothetical_units: -1, kickoff_ts: '2026-10-02' }, { side: 'AWAY', ats_result: 'PUSH', hypothetical_units: 0, kickoff_ts: '2026-10-03' }], { hypothetical: true });
  chk('ATS denominator excludes pushes; ROI includes them', bt.ats_pct === 0.5 && bt.pushes === 1 && bt.roi === U.r(-0.091 / 3, 4), bt);
  chk('max drawdown', bt.max_drawdown === 1);
}

/* ═══ 7. data quality, near misses, miss classification ════════════════ */
{
  chk('worst check wins', L.dqStatus([{ status: 'GREEN' }, { status: 'YELLOW' }]) === 'YELLOW' && L.dqStatus([{ status: 'YELLOW' }, { status: 'RED' }]) === 'RED');
  const red = row({ dq: { status: 'RED', checks: [{ check: 'team_mapping', status: 'RED', detail: 'swapped' }] }, conf: 95 }, 'T24', '2026-10-02T21:00:00.000Z', L.marketAt([q({ home_line: -8, observed_at: '2026-10-02T20:00:00.000Z' })], '2026-10-02T21:00:00.000Z', K));
  chk('RED data quality forces PASS and caps confidence at 40', red.decision_class === 'PASS' && /data quality RED/.test(red.pass_reason) && red.football_confidence === 40 && red.football_confidence_raw === 95, red);
  const dq = M.dataQuality({ slateGame: { home_team: 'Away St', away_team: 'Home U', input_contract: [] }, model: proj(), market: null, hours: 20, now: '2026-10-02T23:30:00.000Z', dupPairs: new Map() });
  chk('home/away swapped against the schedule is RED', dq.status === 'RED' && dq.checks.some((c) => c.check === 'team_mapping' && c.status === 'RED'));
  const td = L.thresholdDistance(0.055, 2.8, 80, { lean_ev: 0, bet_ev: 0.06, bet_gap: 3, bet_min_rel: 0 });
  chk('threshold distances', td.ev_minus_bet_ev === -0.005 && td.gap_minus_bet_gap === -0.2);
  chk('near miss within 0.01 EV and 0.5 pt', L.nearMiss('LEAN', td) === true && L.nearMiss('LEAN', L.thresholdDistance(0.02, 1, 80, { lean_ev: 0, bet_ev: 0.06, bet_gap: 3, bet_min_rel: 0 })) === false);
  chk('a BET is never a near miss', L.nearMiss('BET', td) === false);
  chk('miss severity 10 / 14 / 21', L.missSeverity(9.9) === null && L.missSeverity(10) === 10 && L.missSeverity(15) === 14 && L.missSeverity(30) === 21);
  chk('miss: data RED -> DATA_FAILURE', L.classifyMiss({ data_quality_status: 'RED' }).classification === 'DATA_FAILURE');
  chk('miss: QB changed -> INFORMATION_CHANGE', L.classifyMiss({ qb_changed_from_expected: true, abs_error: 20, close_abs_error: 5 }).classification === 'INFORMATION_CHANGE');
  chk('miss: luck factors AND the close missed too -> HIGH_VARIANCE_OUTCOME', L.classifyMiss({ turnover_margin_abs: 4, abs_error: 20, close_abs_error: 18 }).classification === 'HIGH_VARIANCE_OUTCOME');
  chk('miss: luck factors but the close was far closer -> not variance', L.classifyMiss({ turnover_margin_abs: 4, abs_error: 20, close_abs_error: 6 }).classification === 'MODEL_FAILURE');
  chk('miss: no evidence -> UNKNOWN (never "variance" by default)', L.classifyMiss({ abs_error: 15, close_abs_error: 14 }).classification === 'UNKNOWN');
}

/* ═══ 8. governance, partitions, promotion ═════════════════════════════ */
{
  const d = tmp(), s = storeIn(d);
  const seeded = GOV.seed(s);
  chk('seed: three models, four experiments, partitions', seeded.roles === 3 && seeded.experiments === 4 && seeded.partitions > 0);
  chk('seed is idempotent', JSON.stringify(GOV.seed(s)) === JSON.stringify({ roles: 0, experiments: 0, partitions: 0 }));
  chk('V1 is the champion', GOV.champion(s.gov('model_roles')) === 'edgedesk_cfb_p4_v1.0.0');
  chk('promotion needs a reason and a person', throws(() => GOV.promote(s, 'edgedesk_cfb_v2.1.0', null, null)));
  GOV.promote(s, 'edgedesk_cfb_v2.1.0', 'test promotion', 'tester', { at: '2026-12-01T00:00:00.000Z' });
  const roles = GOV.currentRoles(s.gov('model_roles'));
  chk('one champion after promotion; the old one demoted', roles['edgedesk_cfb_v2.1.0'].role === 'champion' && roles['edgedesk_cfb_p4_v1.0.0'].role === 'challenger');
  chk('promotion is audited', s.gov('audit_log').some((a) => a.event_type === 'MODEL_PROMOTED' && a.subject === 'edgedesk_cfb_v2.1.0'));
  chk('the champion cannot be retired directly', throws(() => GOV.retire(s, 'edgedesk_cfb_v2.1.0', 'x', 'y')));
  chk('a SINGLE_CHANGE experiment with two changes is refused', throws(() => GOV.experimentCreate(s, { id: 'EXP-9', name: 'x', baseline: 'a', challenger: 'b', hypothesis: 'h', change: ['one', 'two'], scope: 'SINGLE_CHANGE' })));
  chk('an experiment without a hypothesis is refused', throws(() => GOV.experimentCreate(s, { id: 'EXP-10', name: 'x', baseline: 'a', challenger: 'b', change: 'c' })));
  const parts = s.gov('partitions');
  chk('live 2026 is not tuning data', !L.canUseForTuning({ season: 2026, week: 6, origin: 'LIVE' }, parts));
  chk('2019 is development data', L.canUseForTuning({ season: 2019, week: 3, origin: 'REPLAY' }, parts));
  chk('2027 is the future holdout', L.poolFor({ season: 2027, week: 1, origin: 'LIVE' }, parts) === 'future_holdout_pool');
  chk('a live season cannot be released before its promotion evaluation exists', throws(() => GOV.releasePartition(s, 2031, 'tester', 'why')));
  const pairs = [];
  for (let i = 0; i < 160; i++) {
    const err = (i % 7) - 3;
    pairs.push({ week: 1 + (i % 10), champ: { abs_margin_error: 12 + Math.abs(err), margin_error: err, final_margin: 7, squared_margin_error: (12 + Math.abs(err)) ** 2, p_home: 0.6, home_won: 1, brier_win: 0.16, in_interval_80: i % 5 !== 0 },
      chall: { abs_margin_error: 11 + Math.abs(err), margin_error: err, final_margin: 7, squared_margin_error: (11 + Math.abs(err)) ** 2, p_home: 0.62, home_won: 1, brier_win: 0.1444, in_interval_80: i % 5 !== 0 } });
  }
  const pe = L.promotionEval(pairs);
  chk('promotion: a clearly better challenger is ELIGIBLE', pe.decision === 'ELIGIBLE' && pe.gates.G1_mae_ci_below_zero, pe);
  chk('promotion: under 150 games is INSUFFICIENT_SAMPLE', L.promotionEval(pairs.slice(0, 40)).decision === 'INSUFFICIENT_SAMPLE');
  chk('promotion never changes the champion by itself', /never changes the champion/.test(pe.note));
}

/* ═══ 9. end to end: snapshots -> settle -> reports -> public record ════ */
(async () => {
  const d = tmp(), s = storeIn(d), so = { root: path.join(d, 'ledger'), govRoot: path.join(d, 'gov') };
  GOV.seed(s);
  const models = [
    { model_version: 'edgedesk_cfb_p4_v1.0.0', label: 'V1', projections: new Map([['g1', proj({ mv: 'edgedesk_cfb_p4_v1.0.0', label: 'V1', game_id: 'g1', margin: 6, conf: 85 })], ['g2', proj({ mv: 'edgedesk_cfb_p4_v1.0.0', label: 'V1', game_id: 'g2', margin: -2, conf: 60, kickoff: '2026-10-03T23:00:00.000Z' })]]) },
    { model_version: 'edgedesk_cfb_v2.1.0', label: 'V2.1', projections: new Map([['g1', proj({ mv: 'edgedesk_cfb_v2.1.0', label: 'V2.1', game_id: 'g1', margin: 4 })], ['g2', proj({ mv: 'edgedesk_cfb_v2.1.0', label: 'V2.1', game_id: 'g2', margin: -5, kickoff: '2026-10-03T23:00:00.000Z' })]]) },
  ];
  /* g1: opens -3, re-quoted unchanged (the 6-hour heartbeat keeps a quiet
     market current), moves to -5 on game day */
  s.appendQuotes([q({ game_id: 'g1', observed_at: '2026-09-29T12:00:00.000Z', home_line: -3 }), q({ game_id: 'g1', observed_at: '2026-10-02T12:00:00.000Z', home_line: -3, is_heartbeat: true }),
    q({ game_id: 'g1', observed_at: '2026-10-03T18:00:00.000Z', home_line: -5, book: 'dk' }),
    q({ game_id: 'g2', kickoff_ts: '2026-10-03T23:00:00.000Z', observed_at: '2026-09-29T12:00:00.000Z', home_line: 1 }), q({ game_id: 'g2', kickoff_ts: '2026-10-03T23:00:00.000Z', observed_at: '2026-10-03T21:00:00.000Z', home_line: 3 })]);
  const times = ['2026-09-29T13:00:00.000Z', '2026-09-30T20:00:00.000Z', '2026-10-01T20:00:00.000Z', '2026-10-02T20:00:00.000Z', '2026-10-03T08:00:00.000Z', '2026-10-03T14:00:00.000Z', '2026-10-03T18:00:00.000Z', '2026-10-03T19:00:00.000Z', '2026-10-03T21:30:00.000Z', '2026-10-03T22:30:00.000Z'];
  const taken = [];
  times.forEach((t) => taken.push(CP.run({ now: t, season: 2026, models, storeOpts: so })));
  const preds = s.predictions();
  const g1 = preds.filter((p) => p.game_id === 'g1' && p.model_version === 'edgedesk_cfb_v2.1.0').map((p) => p.checkpoint_type);
  chk('hourly runs take each window once: OPEN T72 T48 T24 T12 T6 T2 FINAL', JSON.stringify(g1) === JSON.stringify(['OPEN', 'T72', 'T48', 'T24', 'T12', 'T6', 'T2', 'FINAL']), g1);
  chk('re-running the same hour takes nothing', CP.run({ now: times[3], season: 2026, models, storeOpts: so }).taken === 0);
  chk('every row carries its model version and role at snapshot time', preds.every((p) => p.model_version && p.model_role));
  const off = preds.filter((p) => p.official_families.includes('OFFICIAL'));
  chk('exactly one OFFICIAL per game per model', off.length === 4 && off.every((p) => p.checkpoint_type === 'T24'));
  chk('no snapshot at or after kickoff', preds.every((p) => U.ms(p.prediction_ts) < U.ms(p.kickoff_ts)));
  const t24 = preds.find((p) => p.game_id === 'g1' && p.model_version === 'edgedesk_cfb_v2.1.0' && p.checkpoint_type === 'T24');
  chk('the T24 snapshot saw the market of its moment', t24.current_spread === -3 && t24.opening_spread === -3 && t24.sportsbook_count === 1,
    { current_spread: t24.current_spread, opening_spread: t24.opening_spread, n: t24.sportsbook_count, ts: t24.prediction_ts, stale: t24.market_stale, as_of: t24.market_as_of });
  const log = await ST.run({ now: '2026-10-04T06:00:00.000Z', season: 2026, offline: true, useRecord: false, storeOpts: so,
    readings: [{ g1: { source: 'espn', status: 'FINAL', home_points: 20, away_points: 17, overtime: false }, g2: { source: 'espn', status: 'CANCELED' } },
      { g1: { source: 'cfbfastR', status: 'FINAL', home_points: 20, away_points: 17 } }] });
  chk('settle: results, lines, evaluations', log.results === 2 && log.evaluations > 0, log);
  const ev = s.evaluations();
  const e24 = ev.find((e) => e.prediction_id === t24.prediction_id);
  chk('official grading: V2.1 +4 vs final +3 -> error -1; close -5 (the 18:00 quote)', e24 && e24.margin_error === -1 && e24.close_home_line === -5 && e24.close_quality === 'OBSERVED', e24);
  chk('canceled game graded VOID for every snapshot', ev.filter((e) => e.game_id === 'g2').every((e) => e.void === true));
  chk('evaluations are append-only: a rerun adds nothing', (await ST.run({ now: '2026-10-04T07:00:00.000Z', season: 2026, offline: true, useRecord: false, storeOpts: so, readings: [{ g1: { source: 'espn', status: 'FINAL', home_points: 20, away_points: 17 } }] })).evaluations === 0);
  const out = path.join(d, 'reports'), pub = path.join(d, 'public.json');
  RP.run({ now: '2026-10-06T12:00:00.000Z', season: 2026, storeOpts: so, outDir: out, publicPath: pub });
  const lab = JSON.parse(fs.readFileSync(path.join(out, 'lab.json'), 'utf8'));
  chk('lab.json has every section', ['health', 'this_week', 'performance', 'comparison', 'error_analysis', 'edge_analysis', 'market_discovery', 'governance', 'reconstructed'].every((k) => k in lab));
  chk('performance is attributed per model version (a model with a role but no snapshots is shown at n = 0)',
    Object.keys(lab.performance).sort().join() === 'edgedesk_cfb_p4_v1.0.0,edgedesk_cfb_v2.0.0,edgedesk_cfb_v2.1.0'
      && lab.performance['edgedesk_cfb_v2.0.0'].official.errors.n === 0 && lab.performance['edgedesk_cfb_v2.1.0'].official.errors.n > 0
      && lab.performance['edgedesk_cfb_p4_v1.0.0'].official.errors.n > 0, Object.fromEntries(Object.entries(lab.performance).map(([k, v]) => [k, v.official.errors.n])));
  chk('promotion evaluations name the challenger and the champion by version', lab.comparison.promotion.evaluations.every((e) => typeof e.challenger === 'string' && e.champion === 'edgedesk_cfb_p4_v1.0.0' && 'challenger_stats' in e));
  chk('timing table covers the checkpoints', lab.edge_analysis['edgedesk_cfb_v2.1.0'].timing.filter((t) => t.n > 0).length >= 6);
  const wk = path.join(out, 'week_06.json');
  chk('weekly report written once the week is complete', fs.existsSync(wk) && fs.existsSync(path.join(out, 'week_06.md')));
  const first = fs.readFileSync(wk, 'utf8');
  RP.run({ now: '2026-10-07T12:00:00.000Z', season: 2026, storeOpts: so, outDir: out, publicPath: pub });
  chk('a written weekly report is never regenerated', fs.readFileSync(wk, 'utf8') === first);
  const W = JSON.parse(first);
  chk('weekly report has the postmortem sections and the no-overreaction policy', ['what_worked', 'what_failed', 'what_changed', 'what_may_be_random', 'what_deserves_investigation'].every((k) => Array.isArray(W.postmortem[k])) && /Nothing in this report changes a model/.test(W.policy));
  const P = JSON.parse(fs.readFileSync(pub, 'utf8'));
  chk('public record: champion OFFICIAL LIVE only, losses included, void excluded', P.counts.graded === 1 && P.games.length === 1 && P.games[0].model_version === 'edgedesk_cfb_p4_v1.0.0', P.counts);
  chk('public record prints its rules and sample size', P.rules.official_prediction && P.counts.label === 'small sample');
  const sm = lab.comparison.submodels.rows.map((r) => r.name);
  chk('submodel scoreboard lists components and ensembles', sm.some((n) => /C_ridge/.test(n)) && sm.some((n) => /ensemble/.test(n)));

  /* ═══ 10. real adapters load (the published files) ═══════════════════ */
  try {
    const ms = M.loadModels(['v1', 'v2.1', 'c001']);
    chk('adapters load V1, V2.1 and candidate 001', ms.length === 3 && ms.every((m) => m.model_version));
    const any = ms.find((m) => m.projections.size);
    if (any) { const p = [...any.projections.values()][0]; chk('an adapter projection has a margin and a kickoff', U.isNum(p.pure.margin) && !!p.game.kickoff); }
  } catch (e) { chk('adapters load', false, e.message); }

  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
