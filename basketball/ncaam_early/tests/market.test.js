'use strict';
/* NCAAM-EARLY — the market join (marketjoin.js), the decimal path of the
   market comparison (market.js), and the quotes and market parts end to end.
   Synthetic boards only: no Odds API response is committed.
     node basketball/ncaam_early/tests/market.test.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const MJ = require('../marketjoin');
const MK = require('../market');
const M = require('../model');
const C = require('../config');
const FE = require('../features');
const ING = require('../ingest');

let pass = 0, fail = 0; const fails = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; fails.push(name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400))); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);
const cfg = FE.loadConfig();

const NOW = '2026-11-05T12:00:00Z', nowMs = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const book = (key, spread, total, ml, home, away) => { home = home || 'Beta Tech Owls'; away = away || 'Alpha State Hawks'; return { key, markets: [
  { key: 'spreads', outcomes: [{ name: home, price: spread[1], point: spread[0] }, { name: away, price: spread[2], point: -spread[0] }] },
  { key: 'totals', outcomes: [{ name: 'Over', price: total[1], point: total[0] }, { name: 'Under', price: total[2], point: total[0] }] },
  { key: 'h2h', outcomes: [{ name: home, price: ml[0] }, { name: away, price: ml[1] }] }] }; };
const event = (id, tipMs, books, o) => Object.assign({ id, commence_time: iso(tipMs), home_team: 'Beta Tech Owls', away_team: 'Alpha State Hawks', bookmakers: books }, o || {});

/* ── names ─────────────────────────────────────────────────────────────────── */
chk('norm: case, accents, apostrophes, periods and & do not distinguish a team', MJ.norm("Hawai'i Rainbow Warriors") === MJ.norm('HAWAII  rainbow-warriors')
  && MJ.norm('Texas A&M Aggies') === MJ.norm('Texas A and M Aggies') && MJ.norm('St. John’s Red Storm') === MJ.norm('St Johns Red Storm') && MJ.norm('San José State') === MJ.norm('San Jose State'));
chk('norm: different schools stay different', MJ.norm('Miami (OH) RedHawks') !== MJ.norm('Miami Hurricanes'));

/* ── parseBoard ─────────────────────────────────────────────────────────────── */
{
  const tip = nowMs + 10 * 3600e3;
  const b1 = { fingerprint: 'f', snapshot_at: iso(nowMs - 40 * 60e3), odds_format: 'decimal', events: [event('ev1', tip, [book('draftkings', [-3.5, 1.91, 1.91], [141.5, 1.87, 1.95], [1.62, 2.40])])] };
  const b2 = { fingerprint: 'f', snapshot_at: iso(nowMs - 10 * 60e3), odds_format: 'decimal', events: [event('ev1', tip, [book('draftkings', [-4.5, 1.95, 1.87], [142.5, 1.91, 1.91], [1.60, 2.45])])] };
  const p = MJ.parseBoard([b1, b2]);
  const sp = p.quotes.find((q) => q.market === 'spread');
  chk('board: one quote per event, book and market; the latest board wins', p.quotes.length === 3 && sp.line === -4.5 && sp.price_a === 1.95 && sp.captured_at === b2.snapshot_at, p.quotes);
  chk('board: the spread line is the HOME spread, prices a / b are home / away', sp.home_team === 'Beta Tech Owls' && sp.price_b === 1.87);
  const tot = p.quotes.find((q) => q.market === 'total'), ml = p.quotes.find((q) => q.market === 'moneyline');
  chk('board: a total is over / under at one point; a moneyline has no line', tot.line === 142.5 && tot.price_a === 1.91 && ml.line === null && ml.price_a === 1.60 && ml.price_b === 2.45);
  chk('board: captured_at is when the gateway received the board, not the book\'s own stamp', p.quotes.every((q) => q.captured_at === b2.snapshot_at));
  const am = MJ.parseBoard([{ fingerprint: 'g', snapshot_at: iso(nowMs), odds_format: 'american', events: [event('ev9', tip, [book('fanduel', [-2, -110, -110], [140, 100, -120], [-150, 130])])] }]);
  chk('board: an American board is converted to decimal exactly', near(am.quotes.find((q) => q.market === 'spread').price_a, 1 + 100 / 110) && near(am.quotes.find((q) => q.market === 'moneyline').price_b, 2.3)
    && near(am.quotes.find((q) => q.market === 'total').price_a, 2));
  const bad = MJ.parseBoard([{ fingerprint: 'h', snapshot_at: iso(nowMs), odds_format: 'decimal', events: [
    event('live', nowMs - 60e3, [book('dk', [-1, 1.9, 1.9], [140, 1.9, 1.9], [1.8, 2])]),
    event('e2', tip, [{ key: 'b1', markets: [{ key: 'spreads', outcomes: [{ name: 'Beta Tech Owls', price: 1.9, point: -3 }, { name: 'Alpha State Hawks', price: 1.9, point: 2.5 }] }] },
      { key: 'b2', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 140 }, { name: 'Under', price: 1.9, point: 140.5 }] }] },
      { key: 'b3', markets: [{ key: 'h2h', outcomes: [{ name: 'Beta Tech Owls', price: 1.0 }, { name: 'Alpha State Hawks', price: 3 }] }] },
      { key: 'b4', markets: [{ key: 'h2h', outcomes: [{ name: 'Beta Tech Owls', price: 1.5 }] }] },
      { key: 'b5', markets: [{ key: 'player_points', outcomes: [] }] }]),
    { id: 'e3', home_team: 'X' }] }]);
  const why = bad.rejected.map((r) => r.reason).sort();
  chk('board: a price seen at or after commence, mismatched points, a price of 1, a missing side and an incomplete event are rejected with reasons; a non-main market is ignored',
    bad.quotes.length === 0 && JSON.stringify(why) === JSON.stringify(['EVENT_INCOMPLETE', 'OUTCOMES_NOT_ONE_EACH', 'PRICE_INVALID', 'SEEN_AT_OR_AFTER_COMMENCE', 'SPREAD_POINTS_NOT_OPPOSITE', 'TOTAL_POINTS_DIFFER']), why);
  chk('board: a board without a snapshot time is rejected whole', MJ.parseBoard([{ fingerprint: 'z', events: [event('x', tip, [])] }]).rejected[0].reason === 'BOARD_WITHOUT_SNAPSHOT_TIME');
}

/* ── matchEvents ────────────────────────────────────────────────────────────── */
{
  const names = new Map([['e1', 'Alpha State Hawks'], ['e2', 'Beta Tech Owls'], ['e3', 'Gamma College Gulls'], ['e4', 'Delta U Ducks'], ['d1', 'Twin Tigers'], ['d2', 'Twin Tigers']]);
  const tip = nowMs + 10 * 3600e3;
  const tg = (id, h, a, ms) => ({ game_id: id, home_espn: h, away_espn: a, start_utc: iso(ms) });
  const ev = (id, h, a, ms) => ({ event_id: id, home_team: h, away_team: a, commence_time: iso(ms) });
  const r = MJ.matchEvents([tg('g1', 'e2', 'e1', tip), tg('g2', 'e1', 'e3', tip), tg('g3', 'e3', 'e4', tip), tg('g4', 'e4', 'e2', tip)],
    [ev('o1', 'Beta Tech Owls', 'Alpha State Hawks', tip + 15 * 60e3), ev('o2', 'Gamma College Gulls', 'ALPHA STATE HAWKS', tip),
     ev('o3', 'Gamma College Gulls', 'Delta U Ducks', tip + 4 * 3600e3), ev('o4', 'Delta U Ducks', 'Unknown Sea Lions', tip)], names);
  chk('match: both names and the tip (within 3 h) identify the game', r.matches.get('g1').status === 'MATCHED' && r.matches.get('g1').event_id === 'o1' && !r.matches.get('g1').swapped && r.matches.get('g1').basis === 'NAMES_AND_TIP');
  chk('match: the books\' home / away reversed is matched and marked swapped', r.matches.get('g2').status === 'MATCHED' && r.matches.get('g2').swapped && r.matches.get('g2').basis === 'NAMES_AND_TIP_HOME_AWAY_SWAPPED');
  chk('match: commence more than 3 h from the tip is not the game', r.matches.get('g3').status === 'UNMATCHED');
  chk('match: an odds name not in the team list is never guessed, and is reported', r.matches.get('g4').status === 'UNMATCHED' && r.unresolved_names.includes('Unknown Sea Lions'));
  const amb = MJ.matchEvents([tg('g1', 'e2', 'e1', tip)], [ev('o1', 'Beta Tech Owls', 'Alpha State Hawks', tip), ev('o9', 'Beta Tech Owls', 'Alpha State Hawks', tip + 3600e3)], names);
  chk('match: two candidate events for one game: AMBIGUOUS, not matched', amb.matches.get('g1').status === 'AMBIGUOUS' && amb.matches.get('g1').candidates === 2);
  const two = MJ.matchEvents([tg('g1', 'e2', 'e1', tip), tg('g9', 'e2', 'e1', tip + 3600e3)], [ev('o1', 'Beta Tech Owls', 'Alpha State Hawks', tip)], names);
  chk('match: one event that fits two games matches neither', two.matches.get('g1').status === 'AMBIGUOUS' && two.matches.get('g9').status === 'AMBIGUOUS');
  const dup = MJ.matchEvents([tg('g1', 'd1', 'e1', tip)], [ev('o1', 'Twin Tigers', 'Alpha State Hawks', tip)], names);
  chk('match: a name two teams share identifies neither', dup.matches.get('g1').status === 'UNMATCHED');
  const al = MJ.matchEvents([tg('g4', 'e4', 'e2', tip)], [ev('o4', 'Delta Univ. Ducks', 'Beta Tech Owls', tip)], names, new Map([[MJ.norm('Delta Univ. Ducks'), 'e4']]));
  chk('match: an alias resolves an odds name to its ESPN team', al.matches.get('g4').status === 'MATCHED');
}

/* ── quotesFor: orientation ─────────────────────────────────────────────────── */
{
  const q = [{ event_id: 'o2', book: 'dk', market: 'spread', line: -3.5, price_a: 1.8, price_b: 2.0, captured_at: NOW },
             { event_id: 'o2', book: 'dk', market: 'total', line: 141, price_a: 1.9, price_b: 1.92, captured_at: NOW },
             { event_id: 'o2', book: 'dk', market: 'moneyline', line: null, price_a: 1.6, price_b: 2.4, captured_at: NOW }];
  const g = MJ.quotesFor(q, new Map([['g2', { status: 'MATCHED', event_id: 'o2', swapped: true }], ['gx', { status: 'UNMATCHED' }]])).get('g2');
  chk('orientation: a swapped event\'s home spread -3.5 is the game\'s home +3.5, prices exchanged', g.spread[0].line === 3.5 && g.spread[0].dec_a === 2.0 && g.spread[0].dec_b === 1.8);
  chk('orientation: a swapped moneyline is exchanged; a total is not', g.moneyline[0].dec_a === 2.4 && g.total[0].dec_a === 1.9 && g.total[0].line === 141);
  const g0 = MJ.quotesFor(q, new Map([['g1', { status: 'MATCHED', event_id: 'o2', swapped: false }]])).get('g1');
  chk('orientation: an unswapped event is passed through', g0.spread[0].line === -3.5 && g0.spread[0].dec_a === 1.8);
}

/* ── market.js: the decimal path ───────────────────────────────────────────── */
{
  const proj = M.project({ off: 4, allow: -2, tempo: 1, var_side: 4 }, { off: 0, allow: 1, tempo: -1, var_side: 6 }, false, { mu: 108, eta: 2.25, tau: 68 }, cfg);
  const at = iso(nowMs - 5 * 60e3);
  const am = MK.compare('spread', proj, [{ book: 'b1', line: -6.5, price_a: -110, price_b: -110, captured_at: at }, { book: 'b2', line: -6.5, price_a: -105, price_b: -115, captured_at: at }, { book: 'b3', line: -7, price_a: 100, price_b: -120, captured_at: at }], NOW, cfg);
  const de = MK.compare('spread', proj, [{ book: 'b1', line: -6.5, dec_a: 1 + 100 / 110, dec_b: 1 + 100 / 110, captured_at: at }, { book: 'b2', line: -6.5, dec_a: 1 + 100 / 105, dec_b: 1 + 100 / 115, captured_at: at }, { book: 'b3', line: -7, dec_a: 2, dec_b: 1 + 100 / 120, captured_at: at }], NOW, cfg);
  chk('decimal: the same prices as decimal give the same Edge, book, line and reference as American', am.sides.length === 2 && de.sides.every((s, i) => near(s.edge, am.sides[i].edge, 1e-12) && s.book === am.sides[i].book && s.line === am.sides[i].line)
    && near(de.reference.fair_a, am.reference.fair_a, 1e-12), { am: am.sides, de: de.sides });
  const s = de.sides[0];
  chk('decimal: Edge = p_model x decimal - 1 at that price\'s own line', near(s.edge, s.p_model * s.decimal - 1) && near(s.p_model, s.line === -7 ? M.coverProb(proj, -7).home_cover : M.coverProb(proj, -6.5).home_cover));
  chk('decimal: the American price is reported back from the decimal', near(de.sides.find((x) => x.book === 'b3' && x.side === 'a') ? de.sides.find((x) => x.book === 'b3' && x.side === 'a').price_american : 100, 100) && de.books_fresh === 3);
  chk('decimal: a decimal price of 1 or less is not a quote', MK.compare('total', proj, [{ book: 'b1', line: 140, dec_a: 1, dec_b: 1.9, captured_at: at }], NOW, cfg).flags[0] === 'NO_PRICE');
}

/* ── the quotes and market parts end to end ───────────────────────────────── */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaam-early-mk-'));
  const real = C.PATHS.cache, realRaw = C.PATHS.raw;
  C.PATHS.cache = tmp; C.PATHS.raw = (s, p) => path.join(tmp, 'raw', String(s), p + '.json.gz');
  try {
    const put = (s, part, body) => { const f = C.PATHS.raw(s, part); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(body)))); };
    const ps = (o) => Object.assign({ season: 2026, seasonLabel: '2025-26', games: 30, minutes: 900, points: 300, assists: 60, turnovers: 45, fouls: 60, steals: 30, blocks: 15, usage: 20,
      rebounds: { total: 120, offensive: 30, defensive: 90 }, fieldGoals: { made: 110, attempted: 250 }, freeThrows: { made: 60, attempted: 80 } }, o);
    put(2026, 'player_seasons', [ps({ teamId: 1, athleteId: 10, name: 'Synthetic A' }), ps({ teamId: 2, athleteId: 20, name: 'Synthetic B', points: 200 })]);
    put(2026, 'teams', [{ id: 1, sourceId: 'e1', conferenceId: 7 }, { id: 2, sourceId: 'e2', conferenceId: 8 }]);
    put(2027, 'teams', [{ id: 1, sourceId: 'e1', conferenceId: 7 }, { id: 2, sourceId: 'e2', conferenceId: 8 }]);
    put(2027, 'rosters', [{ teamId: 1, season: 2027, players: [{ id: 10, name: 'Synthetic A', startSeason: 2025, height: 77 }] }, { teamId: 2, season: 2027, players: [{ id: 20, name: 'Synthetic B', startSeason: 2024, height: 79 }] }]);
    const states = { 2026: { mu: 105, tau: 68, eta: 2, s2: 11000, lambda: 300, teams: new Map([['e1', { off: 3, allow: 1, net: 2, tempo: 1 }], ['e2', { off: -1, allow: 2, net: -3, tempo: -2 }]]) } };
    const tip502 = nowMs + 10 * 3600e3, tip504 = nowMs + 20 * 3600e3;
    const fakeD = { load: () => [], engineGames: () => [
      { game_id: 501, home: 'e1', away: 'e2', neutral: false, regime: 'D1_D1', yH: 112, yA: 98, poss: 70, tempo: 70, start_ms: nowMs - 2 * 86400e3 },
      { game_id: 502, home: 'e2', away: 'e1', neutral: false, regime: 'D1_D1', scheduled: true, start_ms: tip502 },
      { game_id: 504, home: 'e1', away: 'e2', neutral: true, regime: 'D1_D1', scheduled: true, start_ms: tip504 } ] };
    const board = { available: true, as_of: NOW, boards: [{ fingerprint: 'fp1', category: 'featured', snapshot_at: iso(nowMs - 20 * 60e3), odds_format: 'decimal', events: [
      event('ev502', tip502, [book('pinnacle', [-2.5, 1.95, 1.95], [140.5, 1.93, 1.97], [1.75, 2.15]), book('draftkings', [-2.5, 1.91, 1.91], [141.5, 1.91, 1.91], [1.74, 2.12]), book('fanduel', [-3.5, 2.02, 1.82], [140.5, 1.95, 1.89], [1.76, 2.10])]),
      event('evX', tip504, [book('draftkings', [-1, 1.9, 1.9], [140, 1.9, 1.9], [1.8, 2], 'Somebody Else', 'Alpha State Hawks')], { home_team: 'Somebody Else', away_team: 'Alpha State Hawks' })] }] };
    const names = new Map([['e1', 'Alpha State Hawks'], ['e2', 'Beta Tech Owls']]);
    const calls = [];
    const db = { async rpc(name, args) { calls.push({ name, args }); if (name === 'ncaam_es_begin_run') return 'run-' + args.p_part; if (name === 'ncaam_es_put') return { inserted: args.p_rows.length }; if (name === 'ncaam_es_ncaab_board') return board; return {}; } };
    const m = await ING.run({ api: { state: { calls: 0, remaining: null, log: [] } }, db, parts: ['project', 'quotes', 'market'], seasons: [2027], mode: 'test', now: NOW, codeSha: 'abc', offline: true,
      ratingStates: () => states, dataset: fakeD, espnNames: names });
    const res = (p) => m.results.find((r) => r.part === p);
    chk('e2e: project, quotes and market all ran ok', ['project', 'quotes', 'market'].every((p) => res(p) && res(p).status === 'ok'), m.results.map((r) => [r.part, r.status, r.error]));
    const reads = calls.filter((c) => c.name === 'ncaam_es_ncaab_board');
    chk('e2e: the board is read once per run, for the next 48 hours, and nothing outside ncaam_es_* is called (no purchase)', reads.length === 1 && reads[0].args.p_from === NOW
      && Date.parse(reads[0].args.p_to) - nowMs === 48 * 3600e3 && calls.every((c) => /^ncaam_es_/.test(c.name)));
    const qrows = calls.filter((c) => c.args && c.args.p_table === 'ncaam_es_market_quotes').flatMap((c) => c.args.p_rows);
    chk('e2e: quotes: every book\'s three markets of both events are stored as history', qrows.length === 12 && qrows.every((q) => q.captured_at === board.boards[0].snapshot_at), qrows.length);
    const cr = calls.filter((c) => c.args && c.args.p_table === 'ncaam_es_market_comparisons').flatMap((c) => c.args.p_rows);
    const g502 = cr.filter((r) => r.espn_game_id === '502'), g504 = cr.filter((r) => r.espn_game_id === '504');
    chk('e2e: market: one row per market for each projected game', cr.length === 6 && g502.length === 3 && g504.length === 3, cr.map((r) => r.comparison_id));
    chk('e2e: the matched game names its odds event, its basis, and its projection (same run)', g502.every((r) => r.odds_event_id === 'ev502' && r.match_basis === 'NAMES_AND_TIP' && r.projection_id === 'run-project:502' && r.comparison_id.startsWith('run-market:502:')));
    const sp = g502.find((r) => r.market === 'spread');
    chk('e2e: a side, book, line, decimal price, model probability and Edge, from three fresh books with Pinnacle as the reference', ['home', 'away'].includes(sp.side) && ['pinnacle', 'draftkings', 'fanduel'].includes(sp.book)
      && near(sp.edge, sp.p_model * sp.price_decimal - 1) && sp.books_fresh === 3 && sp.reference && sp.reference.basis === 'pinnacle', sp);
    chk('e2e: Conviction is one of HIGH / MEDIUM / LOW / PASS and no row carries a stake', cr.every((r) => ['HIGH', 'MEDIUM', 'LOW', 'PASS'].includes(r.conviction)) && !JSON.stringify(cr).match(/"(units?|stake)"/));
    chk('e2e: the unmatched game is on the record as PASS with no side and its reason', g504.every((r) => r.conviction === 'PASS' && r.side === null && r.edge === null && r.match_basis === 'UNMATCHED' && r.flags.includes('NO_MARKET_MATCH: UNMATCHED') && r.flags.includes('NO_PRICE')));
    chk('e2e: every row names the model version and the registered config, and was compared before its tip', cr.every((r) => r.model_version && r.config_sha256 === cfg._sha256 && Date.parse(r.compared_at) < Date.parse(r.start_utc)));
    chk('e2e: the checks report the match and the odds names it could not resolve', res('market').meta.checks.match.MATCHED === 1 && res('market').meta.checks.match.UNMATCHED === 1 && res('market').meta.checks.unresolved_odds_names.includes('Somebody Else'));
    /* a stale board: every market PASS, STALE_PRICE */
    const stale = { available: true, boards: [Object.assign({}, board.boards[0], { snapshot_at: iso(nowMs - 3 * 3600e3) })] };
    const calls2 = [];
    const db2 = { async rpc(name, args) { calls2.push({ name, args }); if (name === 'ncaam_es_begin_run') return 'r2-' + args.p_part; if (name === 'ncaam_es_put') return { inserted: args.p_rows.length }; if (name === 'ncaam_es_ncaab_board') return stale; return {}; } };
    await ING.run({ api: { state: { calls: 0, remaining: null, log: [] } }, db: db2, parts: ['project', 'market'], seasons: [2027], mode: 'test', now: NOW, codeSha: 'abc', offline: true, ratingStates: () => states, dataset: fakeD, espnNames: names });
    const cr2 = calls2.filter((c) => c.args && c.args.p_table === 'ncaam_es_market_comparisons').flatMap((c) => c.args.p_rows).filter((r) => r.espn_game_id === '502');
    chk('e2e: a board older than 90 minutes gives PASS, STALE_PRICE, never an Edge', cr2.length === 3 && cr2.every((r) => r.conviction === 'PASS' && r.flags.includes('STALE_PRICE') && r.edge === null), cr2);
    /* the market part without the project part */
    const m3 = await ING.run({ api: { state: { calls: 0, remaining: null, log: [] } }, db: null, parts: ['market'], seasons: [2027], mode: 'test', now: NOW, offline: true, board, espnNames: names });
    chk('e2e: the market part without the project part of the same run is refused', m3.results[0].status === 'error' && m3.results[0].refused && /needs the project part/.test(m3.results[0].error));
    chk('schedules: hourly = quotes; daily and weekly run quotes then market after project', JSON.stringify(ING.HOURLY) === '["quotes"]' && ING.DAILY.indexOf('market') > ING.DAILY.indexOf('quotes') && ING.DAILY.indexOf('quotes') > ING.DAILY.indexOf('project')
      && ING.WEEKLY.includes('market') && JSON.stringify(ING.parseArgs(['--parts', 'hourly']).parts) === '["quotes"]');
  } catch (e) {
    chk('market end to end ran', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    C.PATHS.cache = real; C.PATHS.raw = realRaw;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NCAAM-EARLY market join — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
